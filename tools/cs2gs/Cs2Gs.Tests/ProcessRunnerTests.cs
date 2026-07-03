// <copyright file="ProcessRunnerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Covers the #1748 subprocess-runner fixes directly against real child
/// processes (CI is Linux-only per <c>.github/workflows/build.yml</c>, so
/// <c>/bin/sh</c> is always available): concurrent stdout+stderr draining
/// (no pipe-buffer deadlock), timeout-triggered kill of a wedged child, and
/// <see cref="System.Diagnostics.ProcessStartInfo.ArgumentList"/>-based
/// argument passing (no hand-rolled quoting).
/// </summary>
public class ProcessRunnerTests
{
    /// <summary>
    /// Writing well past the OS pipe buffer (~64 KB) to BOTH stdout and stderr
    /// before exiting used to deadlock every call site's sequential
    /// <c>ReadToEnd()</c> pair. <see cref="ProcessRunner"/> drains both
    /// concurrently, so this must complete comfortably within the test's own
    /// generous timeout instead of hanging forever.
    /// </summary>
    [Fact]
    public async Task Run_LargeStdoutAndStderr_DoesNotDeadlock()
    {
        // ~200 KB on each stream: several multiples of any plausible OS pipe
        // buffer size, so a sequential ReadToEnd/ReadToEnd pair would wedge.
        string script =
            "yes stdout-line-01234567890123456789012345678901234567890 | head -c 200000 >&1; " +
            "yes stderr-line-01234567890123456789012345678901234567890 | head -c 200000 >&2; " +
            "exit 7";

        Task<ProcessRunResult> runTask = ProcessRunner.RunAsync(
            "/bin/sh",
            new[] { "-c", script },
            timeout: TimeSpan.FromSeconds(30));

        // If ProcessRunner regresses to sequential ReadToEnd, this deadlocks;
        // fail fast instead of hanging the test run indefinitely.
        Task winner = await Task.WhenAny(runTask, Task.Delay(TimeSpan.FromSeconds(20)));
        Assert.True(ReferenceEquals(winner, runTask), "ProcessRunner.Run deadlocked reading large stdout+stderr concurrently.");

        ProcessRunResult result = await runTask;
        Assert.False(result.TimedOut);
        Assert.Equal(7, result.ExitCode);

        // `head -c` byte-count boundaries can land mid-line depending on the
        // platform's pipe/buffering behavior, so assert "comfortably past any
        // OS pipe buffer" rather than an exact byte count.
        Assert.True(result.Stdout.Length >= 190000, $"stdout too short: {result.Stdout.Length}");
        Assert.True(result.Stderr.Length >= 190000, $"stderr too short: {result.Stderr.Length}");
    }

    /// <summary>
    /// A child that never exits must be killed once it exceeds its timeout —
    /// not left to hang the pipeline forever — and the result must clearly
    /// report the timeout rather than silently returning partial/zero output.
    /// </summary>
    [Fact]
    public void Run_ChildExceedsTimeout_IsKilledAndReportsTimeout()
    {
        ProcessRunResult result = ProcessRunner.Run(
            "/bin/sh",
            new[] { "-c", "sleep 60" },
            timeout: TimeSpan.FromMilliseconds(300));

        Assert.True(result.TimedOut);
        Assert.Equal(-1, result.ExitCode);
        Assert.Contains("timed out", result.Stderr, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Arguments containing spaces and embedded quotes must survive intact
    /// via <see cref="System.Diagnostics.ProcessStartInfo.ArgumentList"/>
    /// rather than a hand-rolled quoted command-line string, which is exactly
    /// the class of bug <c>GscInvoker</c>'s old quoting had (#1748 item 4).
    /// </summary>
    [Fact]
    public void Run_ArgumentsWithSpacesAndQuotes_PassThroughExactly()
    {
        string[] args = { "arg with spaces", "arg\"with\"quotes", "trailing\\backslash\\" };

        // `sh -c '... "$@"' _ <args>`: $0 becomes the placeholder "_", and the
        // real arguments land in "$@" exactly as ArgumentList delivered them.
        var shArgs = new[] { "-c", "for a in \"$@\"; do printf '%s\\n' \"$a\"; done", "_" }
            .Concat(args)
            .ToArray();

        ProcessRunResult result = ProcessRunner.Run("/bin/sh", shArgs, timeout: TimeSpan.FromSeconds(10));

        Assert.False(result.TimedOut);
        Assert.Equal(0, result.ExitCode);
        string[] lines = result.Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(args, lines);
    }

    /// <summary>
    /// Stage 4 (and every other stage) must never let a child inherit our
    /// console's stdin: <c>cat</c> with no input reads until EOF, so it only
    /// exits immediately if stdin was redirected and closed rather than
    /// inherited.
    /// </summary>
    [Fact]
    public void Run_NeverInheritsStdin_ChildSeesImmediateEof()
    {
        ProcessRunResult result = ProcessRunner.Run("cat", Array.Empty<string>(), timeout: TimeSpan.FromSeconds(10));

        Assert.False(result.TimedOut);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(string.Empty, result.Stdout);
    }

    /// <summary>
    /// #1817 N1: canceling the caller-supplied token (not the timeout) used to
    /// let <see cref="OperationCanceledException"/> propagate straight past
    /// the timeout-only catch filter, skipping <c>KillTree</c> entirely and
    /// leaking the still-running child. The child must be dead by the time
    /// the exception reaches the caller.
    /// </summary>
    [Fact]
    public async Task Run_ExternalCancellation_ThrowsAndKillsChild()
    {
        using var cts = new CancellationTokenSource();
        const string marker = "gsharp-1817-external-cancel-probe";

        Task<ProcessRunResult> runTask = ProcessRunner.RunAsync(
            "/bin/sh",
            new[] { "-c", $": {marker}; sleep 60" },
            timeout: TimeSpan.FromSeconds(30),
            cancellationToken: cts.Token);

        // Let the child actually start before cancelling externally, so this
        // exercises the external-token path rather than racing process start.
        await Task.Delay(TimeSpan.FromMilliseconds(300));
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => runTask);

        // KillTree runs before the exception is thrown, but reaping is
        // async relative to our assertion; poll briefly instead of asserting
        // instantaneously.
        bool stillRunning = IsProcessRunning(marker);
        for (int i = 0; i < 20 && stillRunning; i++)
        {
            await Task.Delay(100);
            stillRunning = IsProcessRunning(marker);
        }

        Assert.False(stillRunning, "External cancellation must kill the child process tree, not leak it.");
    }

    /// <summary>
    /// #1817 N2: once the drain-timeout window elapses, <c>using var
    /// process</c> disposes the stdout/stderr <see cref="System.IO.StreamReader"/>s
    /// while their read tasks may still be pending, faulting them with
    /// <see cref="ObjectDisposedException"/>. Left unobserved, that becomes an
    /// unobserved task exception once the task is garbage collected.
    /// <see cref="ProcessRunner"/>'s private <c>ObserveWhenDone</c> helper
    /// must attach a continuation that observes any such late fault.
    /// </summary>
    [Fact]
    public void ObserveWhenDone_LateFaultAfterDrainWindow_IsObservedNotUnobserved()
    {
        var pending = new TaskCompletionSource<string>();
        bool unobserved = false;
        EventHandler<UnobservedTaskExceptionEventArgs> handler = (_, e) =>
        {
            unobserved = true;
            e.SetObserved();
        };

        TaskScheduler.UnobservedTaskException += handler;
        try
        {
            System.Reflection.MethodInfo observeWhenDone = typeof(ProcessRunner).GetMethod(
                "ObserveWhenDone", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            Assert.NotNull(observeWhenDone);
            observeWhenDone.Invoke(null, new object[] { pending.Task });

            // Simulate the drain-window expiring and `using var process`
            // disposing the StreamReader out from under the still-pending read.
            pending.SetException(new ObjectDisposedException("StreamReader"));

            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
        }
        finally
        {
            TaskScheduler.UnobservedTaskException -= handler;
        }

        Assert.False(unobserved, "A late read-task fault must be observed by ObserveWhenDone, not left to the finalizer.");
    }

    private static bool IsProcessRunning(string marker)
    {
        var psi = new ProcessStartInfo("pgrep") { RedirectStandardOutput = true, UseShellExecute = false };
        psi.ArgumentList.Add("-f");
        psi.ArgumentList.Add(marker);
        using Process pgrep = Process.Start(psi);
        pgrep.WaitForExit(2000);
        return pgrep.ExitCode == 0;
    }
}

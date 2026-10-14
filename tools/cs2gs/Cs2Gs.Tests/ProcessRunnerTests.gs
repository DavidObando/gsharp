// <copyright file="ProcessRunnerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.Diagnostics
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Tasks
import Xunit

/// Covers the #1748 subprocess-runner fixes directly against real child
/// processes (CI is Linux-only per `.github/workflows/build.yml`, so
/// `/bin/sh` is always available): concurrent stdout+stderr draining
/// (no pipe-buffer deadlock), timeout-triggered kill of a wedged child, and
/// (cref:System.Diagnostics.ProcessStartInfo.ArgumentList)-based
/// argument passing (no hand-rolled quoting).
open class ProcessRunnerTests {
    /// Writing well past the OS pipe buffer (~64 KB) to BOTH stdout and stderr
    /// before exiting used to deadlock every call site's sequential
    /// `ReadToEnd()` pair. (cref:ProcessRunner) drains both
    /// concurrently, so this must complete comfortably within the test's own
    /// generous timeout instead of hanging forever.
    @Fact
    async func Run_LargeStdoutAndStderr_DoesNotDeadlock() {
        // ~200 KB on each stream: several multiples of any plausible OS pipe
        // buffer size, so a sequential ReadToEnd/ReadToEnd pair would wedge.
        let script = "yes stdout-line-01234567890123456789012345678901234567890 | head -c 200000 >&1; " +
            "yes stderr-line-01234567890123456789012345678901234567890 | head -c 200000 >&2; " +
            "exit 7"
        let runTask = ProcessRunner.RunAsync("/bin/sh", []string{"-c", script}, timeout: TimeSpan.FromSeconds(30))
        // If ProcessRunner regresses to sequential ReadToEnd, this deadlocks;
        // fail fast instead of hanging the test run indefinitely.
        let winner = await Task.WhenAny(runTask, Task.Delay(TimeSpan.FromSeconds(20)))
        Assert.True(
            object.ReferenceEquals(winner, runTask),
            "ProcessRunner.Run deadlocked reading large stdout+stderr concurrently."
        )
        let result = await runTask
        Assert.False(result.TimedOut)
        Assert.Equal(7, result.ExitCode)
        // `head -c` byte-count boundaries can land mid-line depending on the
        // platform's pipe/buffering behavior, so assert "comfortably past any
        // OS pipe buffer" rather than an exact byte count.
        Assert.True(result.Stdout.Length >= 190000, "stdout too short: ${result.Stdout.Length}")
        Assert.True(result.Stderr.Length >= 190000, "stderr too short: ${result.Stderr.Length}")
    }

    /// A child that never exits must be killed once it exceeds its timeout —
    /// not left to hang the pipeline forever — and the result must clearly
    /// report the timeout rather than silently returning partial/zero output.
    @Fact
    func Run_ChildExceedsTimeout_IsKilledAndReportsTimeout() {
        let result = ProcessRunner.Run("/bin/sh", []string{"-c", "sleep 60"}, timeout: TimeSpan.FromMilliseconds(300))
        Assert.True(result.TimedOut)
        Assert.Equal(-1, result.ExitCode)
        Assert.Contains("timed out", result.Stderr, StringComparison.OrdinalIgnoreCase)
    }

    /// Arguments containing spaces and embedded quotes must survive intact
    /// via (cref:System.Diagnostics.ProcessStartInfo.ArgumentList)
    /// rather than a hand-rolled quoted command-line string, which is exactly
    /// the class of bug `GscInvoker`'s old quoting had (#1748 item 4).
    @Fact
    func Run_ArgumentsWithSpacesAndQuotes_PassThroughExactly() {
        let args[]string = []string{"arg with spaces", "arg\"with\"quotes", "trailing\\backslash\\"}
        // `sh -c '... "$@"' _ <args>`: $0 becomes the placeholder "_", and the
        // real arguments land in "$@" exactly as ArgumentList delivered them.
        let shArgs = []string{"-c", "for a in \"$$@\"; do printf '%s\\n' \"$$a\"; done", "_"}.Concat(args).ToArray()
        let result = ProcessRunner.Run("/bin/sh", shArgs, timeout: TimeSpan.FromSeconds(10))
        Assert.False(result.TimedOut)
        Assert.Equal(0, result.ExitCode)
        let lines = result.Stdout.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal(args, lines)
    }

    @Fact
    func Run_EnvironmentOverrides_AreVisibleToChild() {
        let result = ProcessRunner.Run(
            "/bin/sh",
            []string{"-c", "printf '%s' \"$$GSHARP_PROCESS_RUNNER_TEST\""},
            timeout: TimeSpan.FromSeconds(10),
            environment: Dictionary[string, string]{["GSHARP_PROCESS_RUNNER_TEST"] = "current-package"}
        )
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("current-package", result.Stdout)
    }

    /// Stage 4 (and every other stage) must never let a child inherit our
    /// console's stdin: `cat` with no input reads until EOF, so it only
    /// exits immediately if stdin was redirected and closed rather than
    /// inherited.
    @Fact
    func Run_NeverInheritsStdin_ChildSeesImmediateEof() {
        let result = ProcessRunner.Run("cat", Array.Empty[string](), timeout: TimeSpan.FromSeconds(10))
        Assert.False(result.TimedOut)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal(string.Empty, result.Stdout)
    }

    /// #1817 N1: canceling the caller-supplied token (not the timeout) used to
    /// let (cref:OperationCanceledException) propagate straight past
    /// the timeout-only catch filter, skipping `KillTree` entirely and
    /// leaking the still-running child. The child must be dead by the time
    /// the exception reaches the caller.
    @Fact
    async func Run_ExternalCancellation_ThrowsAndKillsChild() {
        using let cts = CancellationTokenSource()
        const marker = "gsharp-1817-external-cancel-probe"
        let runTask = ProcessRunner.RunAsync(
            "/bin/sh",
            []string{"-c", ": $marker; sleep 60"},
            timeout: TimeSpan.FromSeconds(30),
            cancellationToken: cts.Token
        )
        // Let the child actually start before cancelling externally, so this
        // exercises the external-token path rather than racing process start.
        await Task.Delay(TimeSpan.FromMilliseconds(300))
        cts.Cancel()
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return runTask
            }
        )
        // KillTree runs before the exception is thrown, but reaping is
        // async relative to our assertion; poll briefly instead of asserting
        // instantaneously.
        var stillRunning = IsProcessRunning(marker)
        for var i = 0; i < 20 && stillRunning; i++ {
            await Task.Delay(100)
            stillRunning = IsProcessRunning(marker)
        }
        Assert.False(stillRunning, "External cancellation must kill the child process tree, not leak it.")
    }

    /// #1817 N2: once the drain-timeout window elapses, `using var
    /// process` disposes the stdout/stderr (cref:System.IO.StreamReader)s
    /// while their read tasks may still be pending, faulting them with
    /// (cref:ObjectDisposedException). Left unobserved, that becomes an
    /// unobserved task exception once the task is garbage collected.
    /// (cref:ProcessRunner)'s private `ObserveWhenDone` helper
    /// must attach a continuation that observes any such late fault.
    @Fact
    func ObserveWhenDone_LateFaultAfterDrainWindow_IsObservedNotUnobserved() {
        let pending = TaskCompletionSource[string]()
        var unobserved = false
        let handler EventHandler[UnobservedTaskExceptionEventArgs] = (
            _ object?,
            e UnobservedTaskExceptionEventArgs
        ) -> {
            unobserved = true
            e.SetObserved()
        }
        TaskScheduler.UnobservedTaskException += handler
        try {
            let observeWhenDone MethodInfo? = typeof(ProcessRunner).GetMethod(
                "ObserveWhenDone",
                BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(observeWhenDone)
            observeWhenDone!!.Invoke(nil, []object{pending.Task})
            // Simulate the drain-window expiring and `using var process`
            // disposing the StreamReader out from under the still-pending read.
            pending.SetException(ObjectDisposedException("StreamReader"))
            GC.Collect()
            GC.WaitForPendingFinalizers()
            GC.Collect()
        } finally {
            TaskScheduler.UnobservedTaskException -= handler
        }
        Assert.False(
            unobserved,
            "A late read-task fault must be observed by ObserveWhenDone, not left to the finalizer."
        )
    }

    shared {
        private func IsProcessRunning(marker string) bool {
            let psi = ProcessStartInfo("pgrep"){RedirectStandardOutput = true, UseShellExecute = false}
            psi.ArgumentList.Add("-f")
            psi.ArgumentList.Add(marker)
            using let pgrep Process? = Process.Start(psi)
            pgrep!!.WaitForExit(2000)
            return pgrep!!.ExitCode == 0
        }
    }
}

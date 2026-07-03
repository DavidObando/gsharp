// <copyright file="ProcessRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The single shared subprocess launcher for every cs2gs pipeline stage
/// (gsc, ilverify, `dotnet test`, and the migrated program under test). Fixes
/// the deadlock/hang/quoting family in #1748 in one place instead of four:
/// stdout and stderr are drained concurrently (never sequential
/// <c>ReadToEnd</c>, which deadlocks once a child fills the pipe it isn't
/// currently being read from), every run is bounded by a timeout that kills
/// the whole process tree on expiry instead of hanging forever, stdin is
/// always redirected and immediately closed so a child can never block
/// waiting on console input it will never receive, and arguments are passed
/// via <see cref="ProcessStartInfo.ArgumentList"/> so no call site hand-quotes
/// a command line.
/// </summary>
public static class ProcessRunner
{
    /// <summary>The default timeout applied when a caller does not supply one.</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Runs <paramref name="fileName"/> to completion (or until <paramref name="timeout"/>
    /// expires) and captures its stdout/stderr concurrently.
    /// </summary>
    /// <param name="fileName">The executable to launch (e.g. <c>dotnet</c>).</param>
    /// <param name="arguments">The argument list, passed unquoted via <see cref="ProcessStartInfo.ArgumentList"/>.</param>
    /// <param name="workingDirectory">The working directory, or <see langword="null"/> to inherit the current one.</param>
    /// <param name="timeout">The maximum wall-clock time to wait before killing the process tree; defaults to <see cref="DefaultTimeout"/>.</param>
    /// <returns>The exit code, captured output, and whether the run timed out.</returns>
    public static ProcessRunResult Run(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory = null,
        TimeSpan? timeout = null) =>
        RunAsync(fileName, arguments, workingDirectory, timeout).GetAwaiter().GetResult();

    /// <summary>The async form of <see cref="Run"/>; see its remarks for behavior.</summary>
    /// <param name="fileName">The executable to launch (e.g. <c>dotnet</c>).</param>
    /// <param name="arguments">The argument list, passed unquoted via <see cref="ProcessStartInfo.ArgumentList"/>.</param>
    /// <param name="workingDirectory">The working directory, or <see langword="null"/> to inherit the current one.</param>
    /// <param name="timeout">The maximum wall-clock time to wait before killing the process tree; defaults to <see cref="DefaultTimeout"/>.</param>
    /// <param name="cancellationToken">A token that, when canceled, also kills the process tree early.</param>
    /// <returns>The exit code, captured output, and whether the run timed out.</returns>
    public static async Task<ProcessRunResult> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory = null,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(fileName))
        {
            throw new ArgumentException("File name must be supplied.", nameof(fileName));
        }

        TimeSpan effectiveTimeout = timeout ?? DefaultTimeout;
        var psi = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        if (!string.IsNullOrEmpty(workingDirectory))
        {
            psi.WorkingDirectory = workingDirectory;
        }

        foreach (string arg in arguments ?? Array.Empty<string>())
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = psi };
        if (!process.Start())
        {
            throw new InvalidOperationException($"Failed to start process '{fileName}'.");
        }

        // No call site needs the child to read from our console, and an
        // inherited stdin lets a translated `Console.ReadLine()` (stage 4)
        // block forever instead of failing fast (#1748). Close it up front.
        process.StandardInput.Close();

        // Read stdout and stderr concurrently. Sequential ReadToEnd on both
        // pipes deadlocks the moment a child fills the OS pipe buffer on the
        // stream we are not currently blocked reading (#1748).
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();

        using var timeoutCts = new CancellationTokenSource(effectiveTimeout);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(timeoutCts.Token, cancellationToken);

        bool timedOut = false;
        try
        {
            await process.WaitForExitAsync(linkedCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Either token can fire here (timeout or an external caller
            // cancellation); either way the child must be killed before we
            // leave, or it leaks as an orphaned process (#1817 N1).
            KillTree(process);
            await DrainOrObserve(stdoutTask, stderrTask).ConfigureAwait(false);

            if (timeoutCts.IsCancellationRequested)
            {
                timedOut = true;
            }
            else
            {
                throw;
            }
        }

        if (timedOut)
        {
            // The kill (above) closes the child's ends of the pipes, which
            // lets the pending reads drain and complete; DrainOrObserve
            // already bounded that wait so a stuck grandchild can't
            // re-introduce a hang.
            string timedOutStderr = SafeResult(stderrTask) +
                $"{Environment.NewLine}[ProcessRunner] '{fileName}' timed out after {effectiveTimeout} and was killed.";
            return new ProcessRunResult(-1, SafeResult(stdoutTask), timedOutStderr, timedOut: true);
        }

        // The process has already exited, so these reads are bounded by the
        // pipes actually closing — this await cannot hang.
        string[] outputs = await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);
        return new ProcessRunResult(process.ExitCode, outputs[0], outputs[1], timedOut: false);
    }

    /// <summary>
    /// Bounds the wait for the stdout/stderr drain tasks to complete after a
    /// kill, and observes their result/fault either way so that a stuck
    /// grandchild's pipes (or the eventual <c>using var process</c> disposal
    /// racing a still-pending read) never produce an unobserved task
    /// exception once we walk away from the tasks (#1817 N2).
    /// </summary>
    private static async Task DrainOrObserve(Task<string> stdoutTask, Task<string> stderrTask)
    {
        await Task.WhenAny(Task.WhenAll(stdoutTask, stderrTask), Task.Delay(TimeSpan.FromSeconds(10)))
            .ConfigureAwait(false);

        // Attach a continuation to any still-pending task so its eventual
        // fault (e.g. ObjectDisposedException once `process` is disposed) is
        // observed instead of becoming an unhandled/unobserved task
        // exception on the finalizer thread.
        ObserveWhenDone(stdoutTask);
        ObserveWhenDone(stderrTask);
    }

    private static void ObserveWhenDone(Task<string> task)
    {
        if (task.IsCompleted)
        {
            _ = task.Exception;
            return;
        }

        _ = task.ContinueWith(t => _ = t.Exception, TaskScheduler.Default);
    }

    private static void KillTree(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Already exited between the timeout firing and the kill call.
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // The OS refused the kill (process already gone/zombie); nothing more to do.
        }
    }

    private static string SafeResult(Task<string> task) =>
        task.Status == TaskStatus.RanToCompletion ? task.Result : string.Empty;
}

/// <summary>
/// The captured outcome of a <see cref="ProcessRunner.Run"/>/<see cref="ProcessRunner.RunAsync"/> invocation.
/// </summary>
public sealed class ProcessRunResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ProcessRunResult"/> class.
    /// </summary>
    /// <param name="exitCode">The process exit code, or <c>-1</c> when <paramref name="timedOut"/>.</param>
    /// <param name="stdout">The captured standard output.</param>
    /// <param name="stderr">The captured standard error (carries a trailing timeout note when <paramref name="timedOut"/>).</param>
    /// <param name="timedOut">Whether the process was killed because it exceeded its timeout.</param>
    public ProcessRunResult(int exitCode, string stdout, string stderr, bool timedOut)
    {
        this.ExitCode = exitCode;
        this.Stdout = stdout ?? string.Empty;
        this.Stderr = stderr ?? string.Empty;
        this.TimedOut = timedOut;
    }

    /// <summary>Gets the process exit code, or <c>-1</c> when <see cref="TimedOut"/>.</summary>
    public int ExitCode { get; }

    /// <summary>Gets the captured standard output.</summary>
    public string Stdout { get; }

    /// <summary>Gets the captured standard error (carries a trailing timeout note when <see cref="TimedOut"/>).</summary>
    public string Stderr { get; }

    /// <summary>Gets a value indicating whether the process was killed for exceeding its timeout.</summary>
    public bool TimedOut { get; }

    /// <summary>Gets the combined stdout+stderr, matching the shape every existing call site consumed.</summary>
    public string Output => this.Stdout + this.Stderr;
}

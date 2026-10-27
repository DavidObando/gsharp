// <copyright file="ProcessRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.ComponentModel
import System.Diagnostics
import System.Threading
import System.Threading.Tasks

/// The single shared subprocess launcher for every cs2gs pipeline stage
/// (gsc, ilverify, `dotnet test`, and the migrated program under test). Fixes
/// the deadlock/hang/quoting family in #1748 in one place instead of four:
/// stdout and stderr are drained concurrently (never sequential
/// `ReadToEnd`, which deadlocks once a child fills the pipe it isn't
/// currently being read from), every run is bounded by a timeout that kills
/// the whole process tree on expiry instead of hanging forever, stdin is
/// always redirected and immediately closed so a child can never block
/// waiting on console input it will never receive, and arguments are passed
/// via (cref:ProcessStartInfo.ArgumentList) so no call site hand-quotes
/// a command line.
shared class ProcessRunner {
    /// The default timeout applied when a caller does not supply one.
    let DefaultTimeout TimeSpan = TimeSpan.FromMinutes(5)

    /// Runs [`fileName`](paramref) to completion (or until [`timeout`](paramref)
    /// expires) and captures its stdout/stderr concurrently.
    /// @param fileName The executable to launch (e.g. `dotnet`).
    /// @param arguments The argument list, passed unquoted via (cref:ProcessStartInfo.ArgumentList).
    /// @param workingDirectory The working directory, or `null` to inherit the current one.
    /// @param timeout The maximum wall-clock time to wait before killing the process tree; defaults to
    /// (cref:DefaultTimeout).
    /// @param environment Environment variables to set or override for the child process.
    /// @returns The exit code, captured output, and whether the run timed out.
    func Run(
        fileName string,
        arguments IReadOnlyList[string],
        workingDirectory string? = nil,
        timeout TimeSpan? = nil,
        environment IReadOnlyDictionary[string, string]? = nil
    ) ProcessRunResult -> RunAsync(fileName, arguments, workingDirectory, timeout, environment: environment)
        .GetAwaiter().GetResult()

    internal func RunWithRemovedEnvironment(
        fileName string,
        arguments IReadOnlyList[string],
        removedEnvironment IReadOnlyList[string],
        workingDirectory string? = nil,
        timeout TimeSpan? = nil
    ) ProcessRunResult -> RunAsyncCore(
        fileName,
        arguments,
        workingDirectory,
        timeout,
        default(CancellationToken),
        nil,
        removedEnvironment
    )
        .GetAwaiter().GetResult()

    /// The async form of (cref:Run); see its remarks for behavior.
    /// @param fileName The executable to launch (e.g. `dotnet`).
    /// @param arguments The argument list, passed unquoted via (cref:ProcessStartInfo.ArgumentList).
    /// @param workingDirectory The working directory, or `null` to inherit the current one.
    /// @param timeout The maximum wall-clock time to wait before killing the process tree; defaults to
    /// (cref:DefaultTimeout).
    /// @param cancellationToken A token that, when canceled, also kills the process tree early.
    /// @param environment Environment variables to set or override for the child process.
    /// @returns The exit code, captured output, and whether the run timed out.
    func RunAsync(
        fileName string,
        arguments IReadOnlyList[string],
        workingDirectory string? = nil,
        timeout TimeSpan? = nil,
        cancellationToken CancellationToken = default(CancellationToken),
        environment IReadOnlyDictionary[string, string]? = nil
    ) Task[ProcessRunResult] -> RunAsyncCore(
        fileName,
        arguments,
        workingDirectory,
        timeout,
        cancellationToken,
        environment,
        nil
    )

    private async func RunAsyncCore(
        fileName string,
        arguments IReadOnlyList[string],
        workingDirectory string?,
        timeout TimeSpan?,
        cancellationToken CancellationToken,
        environment IReadOnlyDictionary[string, string]?,
        removedEnvironment IReadOnlyList[string]?
    ) ProcessRunResult {
        if string.IsNullOrEmpty(fileName) {
            throw ArgumentException("File name must be supplied.", "fileName")
        }
        let effectiveTimeout = timeout ?? DefaultTimeout
        let psi = ProcessStartInfo(fileName){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        }
        if !string.IsNullOrEmpty(workingDirectory) {
            psi.WorkingDirectory = workingDirectory
        }
        for arg in arguments ?? Array.Empty[string]() {
            psi.ArgumentList.Add(arg)
        }
        // Stage 4 grants the original C# source tree only to the mirrored test
        // host. Nested compiler/test/program launches must opt in explicitly;
        // otherwise they could consume original fixtures as build inputs.
        psi.Environment.Remove(GsharpTestProjectRunner.SourceRootEnvironmentVariable)
        if environment != nil {
            for (name, value) in environment {
                psi.Environment[name] = value
            }
        }
        if removedEnvironment != nil {
            for name in removedEnvironment {
                psi.Environment.Remove(name)
            }
        }
        using let process = Process{StartInfo: psi}
        if !process.Start() {
            throw InvalidOperationException("Failed to start process '$fileName'.")
        }
        // No call site needs the child to read from our console, and an
        // inherited stdin lets a translated `Console.ReadLine()` (stage 4)
        // block forever instead of failing fast (#1748). Close it up front.
        process.StandardInput.Close()
        // Read stdout and stderr concurrently. Sequential ReadToEnd on both
        // pipes deadlocks the moment a child fills the OS pipe buffer on the
        // stream we are not currently blocked reading (#1748).
        let stdoutTask = process.StandardOutput.ReadToEndAsync()
        let stderrTask = process.StandardError.ReadToEndAsync()
        using let timeoutCts = CancellationTokenSource(effectiveTimeout)
        using let linkedCts = CancellationTokenSource.CreateLinkedTokenSource(timeoutCts.Token, cancellationToken)
        var timedOut = false
        try {
            await process.WaitForExitAsync(linkedCts.Token).ConfigureAwait(false)
        } catch (OperationCanceledException) {
            // Either token can fire here (timeout or an external caller
            // cancellation); either way the child must be killed before we
            // leave, or it leaks as an orphaned process (#1817 N1).
            KillTree(process)
            await DrainOrObserve(stdoutTask, stderrTask).ConfigureAwait(false)
            if timeoutCts.IsCancellationRequested {
                timedOut = true
            } else {
                rethrow
            }
        }
        if timedOut {
            // The kill (above) closes the child's ends of the pipes, which
            // lets the pending reads drain and complete; DrainOrObserve
            // already bounded that wait so a stuck grandchild can't
            // re-introduce a hang.
            let timedOutStderr = SafeResult(stderrTask) +
                "${Environment.NewLine}[ProcessRunner] '$fileName' timed out after $effectiveTimeout and was killed."
            return ProcessRunResult(-1, SafeResult(stdoutTask), timedOutStderr, timedOut: true)
        }
        // The process has already exited, so these reads are bounded by the
        // pipes actually closing — this await cannot hang.
        let outputs = await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false)
        return ProcessRunResult(process.ExitCode, outputs[0], outputs[1], timedOut: false)
    }

    /// Bounds the wait for the stdout/stderr drain tasks to complete after a
    /// kill, and observes their result/fault either way so that a stuck
    /// grandchild's pipes (or the eventual `using var process` disposal
    /// racing a still-pending read) never produce an unobserved task
    /// exception once we walk away from the tasks (#1817 N2).
    private async func DrainOrObserve(stdoutTask Task[string], stderrTask Task[string]) {
        await Task.WhenAny(Task.WhenAll(stdoutTask, stderrTask), Task.Delay(TimeSpan.FromSeconds(10))).ConfigureAwait(
            false
        )
        // Attach a continuation to any still-pending task so its eventual
        // fault (e.g. ObjectDisposedException once `process` is disposed) is
        // observed instead of becoming an unhandled/unobserved task
        // exception on the finalizer thread.
        ObserveWhenDone(stdoutTask)
        ObserveWhenDone(stderrTask)
    }

    private func ObserveWhenDone(task Task[string]) {
        if task.IsCompleted {
            let _ = task.Exception
            return
        }
        let _ = task.ContinueWith((t Task[string]) -> t.Exception, TaskScheduler.Default)
    }

    private func KillTree(process Process) {
        try {
            process.Kill(entireProcessTree: true)
        } catch (InvalidOperationException) {
            // Already exited between the timeout firing and the kill call.

        } catch (Win32Exception) {
            // The OS refused the kill (process already gone/zombie); nothing more to do.

        }
    }

    private func SafeResult(task Task[string]) string -> if task.Status == TaskStatus.RanToCompletion {
        task.Result
    } else {
        string.Empty
    }
}

/// The captured outcome of a (cref:ProcessRunner.Run)/(cref:ProcessRunner.RunAsync) invocation.
class ProcessRunResult {
    /// Initializes a new instance of the (cref:ProcessRunResult) class.
    /// @param exitCode The process exit code, or `-1` when [`timedOut`](paramref).
    /// @param stdout The captured standard output.
    /// @param stderr The captured standard error (carries a trailing timeout note when
    /// [`timedOut`](paramref)).
    /// @param timedOut Whether the process was killed because it exceeded its timeout.
    init(exitCode int32, stdout string, stderr string, timedOut bool) {
        this.ExitCode = exitCode
        this.Stdout = stdout ?? string.Empty
        this.Stderr = stderr ?? string.Empty
        this.TimedOut = timedOut
    }

    /// Gets the process exit code, or `-1` when (cref:TimedOut).
    prop ExitCode int32 {
        get;
    }

    /// Gets the captured standard output.
    prop Stdout string {
        get;
    }

    /// Gets the captured standard error (carries a trailing timeout note when (cref:TimedOut)).
    prop Stderr string {
        get;
    }

    /// Gets a value indicating whether the process was killed for exceeding its timeout.
    prop TimedOut bool {
        get;
    }

    /// Gets the combined stdout+stderr, matching the shape every existing call site consumed.
    prop Output string -> this.Stdout + this.Stderr
}

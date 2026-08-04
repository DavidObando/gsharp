// <copyright file="EmittedProgramResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Execution;

/// <summary>
/// The observable outcome of compiling a program to memory and executing it
/// in-process via <see cref="EmittedProgramHost"/> (ADR-0156): the emit
/// diagnostics, the entry point's exit code, and any unhandled exception the
/// program surfaced. Standard output and error are not captured here — the
/// program writes to the process console exactly as an emitted executable
/// would, so drivers stream them through unchanged.
/// </summary>
public sealed class EmittedProgramResult
{
    private EmittedProgramResult(
        bool success,
        ImmutableArray<Diagnostic> diagnostics,
        int exitCode,
        Exception unhandledException,
        WeakReference loadContext)
    {
        Success = success;
        Diagnostics = diagnostics;
        ExitCode = exitCode;
        UnhandledException = unhandledException;
        LoadContext = loadContext;
    }

    /// <summary>
    /// Gets a value indicating whether emit succeeded and the program was
    /// executed. When <see langword="false"/>, <see cref="Diagnostics"/>
    /// contains at least one error and the program never ran. Note that a
    /// program which ran but threw (<see cref="UnhandledException"/>) or
    /// returned a non-zero <see cref="ExitCode"/> still reports
    /// <see langword="true"/> here — success describes the compile-and-launch
    /// pipeline, not the program's own outcome.
    /// </summary>
    public bool Success { get; }

    /// <summary>
    /// Gets the emit-time diagnostics: parse, bind, lowering, and emitter
    /// diagnostics, including warnings when emit succeeded.
    /// </summary>
    public ImmutableArray<Diagnostic> Diagnostics { get; }

    /// <summary>
    /// Gets the exit code produced by the program's entry point:
    /// its <see cref="int"/> or <see cref="uint"/> return value, otherwise 0.
    /// Meaningless when <see cref="Success"/> is <see langword="false"/> or
    /// <see cref="UnhandledException"/> is non-null.
    /// </summary>
    public int ExitCode { get; }

    /// <summary>
    /// Gets the unhandled exception the program threw, if any, unwrapped from
    /// the reflection invocation boundary. Drivers surface it on standard
    /// error and exit with <see cref="EmittedProgramHost.UnhandledExceptionExitCode"/>,
    /// mirroring the CLR host's crash protocol.
    /// </summary>
    public Exception UnhandledException { get; }

    /// <summary>
    /// Gets a weak reference to the collectible <see cref="System.Runtime.Loader.AssemblyLoadContext"/>
    /// the program ran in, already unloaded by the time the result is
    /// returned. Test-only seam for asserting the context is reclaimable.
    /// </summary>
    internal WeakReference LoadContext { get; }

    /// <summary>
    /// Creates a result for a compilation whose emit failed; the program never ran.
    /// </summary>
    /// <param name="diagnostics">The emit diagnostics, containing at least one error.</param>
    /// <returns>The failed result.</returns>
    internal static EmittedProgramResult FromFailedEmit(ImmutableArray<Diagnostic> diagnostics)
        => new(success: false, diagnostics, exitCode: 1, unhandledException: null, loadContext: null);

    /// <summary>
    /// Creates a result for a program that was emitted and executed.
    /// </summary>
    /// <param name="diagnostics">The emit diagnostics (warnings only, since emit succeeded).</param>
    /// <param name="exitCode">The entry point's mapped exit code.</param>
    /// <param name="unhandledException">The unhandled exception the program threw, if any.</param>
    /// <param name="loadContext">Weak reference to the unloaded, collectible load context.</param>
    /// <returns>The executed result.</returns>
    internal static EmittedProgramResult FromExecution(
        ImmutableArray<Diagnostic> diagnostics,
        int exitCode,
        Exception unhandledException,
        WeakReference loadContext)
        => new(success: true, diagnostics, exitCode, unhandledException, loadContext);
}

// <copyright file="EmittedProgramResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Execution

import GSharp.Core.CodeAnalysis
import System
import System.Collections.Immutable

/// The observable outcome of compiling a program to memory and executing it
/// in-process via (cref:EmittedProgramHost) (ADR-0156): the emit
/// diagnostics, the entry point's exit code, and any unhandled exception the
/// program surfaced. Standard output and error are not captured here — the
/// program writes to the process console exactly as an emitted executable
/// would, so drivers stream them through unchanged.
class EmittedProgramResult {
    private init(
        success bool,
        diagnostics ImmutableArray[Diagnostic],
        exitCode int32,
        unhandledException Exception?,
        loadContext WeakReference?
    ) {
        Success = success
        Diagnostics = diagnostics
        ExitCode = exitCode
        UnhandledException = unhandledException
        LoadContext = loadContext
    }

    /// Gets a value indicating whether emit succeeded and the program was
    /// executed. When `false`, (cref:Diagnostics)
    /// contains at least one error and the program never ran. Note that a
    /// program which ran but threw ((cref:UnhandledException)) or
    /// returned a non-zero (cref:ExitCode) still reports
    /// `true` here — success describes the compile-and-launch
    /// pipeline, not the program's own outcome.
    prop Success bool {
        get;
    }

    /// Gets the emit-time diagnostics: parse, bind, lowering, and emitter
    /// diagnostics, including warnings when emit succeeded.
    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the exit code produced by the program's entry point:
    /// its (cref:int) or (cref:uint) return value, otherwise 0.
    /// Meaningless when (cref:Success) is `false` or
    /// (cref:UnhandledException) is non-null.
    prop ExitCode int32 {
        get;
    }

    /// Gets the unhandled exception the program threw, if any, unwrapped from
    /// the reflection invocation boundary. Drivers surface it on standard
    /// error and exit with (cref:EmittedProgramHost.UnhandledExceptionExitCode),
    /// mirroring the CLR host's crash protocol.
    prop UnhandledException Exception? {
        get;
    }

    /// Gets a weak reference to the collectible (cref:System.Runtime.Loader.AssemblyLoadContext)
    /// the program ran in, already unloaded by the time the result is
    /// returned. Test-only seam for asserting the context is reclaimable.
    internal prop LoadContext WeakReference? {
        get;
    }

    shared {
        /// Creates a result for a compilation whose emit failed; the program never ran.
        /// @param diagnostics The emit diagnostics, containing at least one error.
        /// @returns The failed result.
        internal func FromFailedEmit(
            diagnostics ImmutableArray[Diagnostic]
        ) EmittedProgramResult -> EmittedProgramResult(
            success: false,
            diagnostics,
            exitCode: 1,
            unhandledException: nil,
            loadContext: nil
        )

        /// Creates a result for a program that was emitted and executed.
        /// @param diagnostics The emit diagnostics (warnings only, since emit succeeded).
        /// @param exitCode The entry point's mapped exit code.
        /// @param unhandledException The unhandled exception the program threw, if any.
        /// @param loadContext Weak reference to the unloaded, collectible load context.
        /// @returns The executed result.
        internal func FromExecution(
            diagnostics ImmutableArray[Diagnostic],
            exitCode int32,
            unhandledException Exception?,
            loadContext WeakReference?
        ) EmittedProgramResult -> EmittedProgramResult(
            success: true,
            diagnostics,
            exitCode,
            unhandledException,
            loadContext
        )
    }
}

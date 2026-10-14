// <copyright file="EmittedProgramHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Execution

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Threading

/// Shared execution host for the evaluating drivers (ADR-0156 Phase 1):
/// compiles a (cref:Compilation.Compilation) with the real emitter into
/// a (cref:MemoryStream), loads the PE bytes into a collectible
/// (cref:AssemblyLoadContext), invokes the entry point in-process, and
/// maps the outcome onto the drivers' exit-code protocol. Framework
/// dependencies resolve through the default load context; user-supplied
/// reference assemblies (`/r:`) resolve from their explicit paths.
/// @remarks The program's console is the host process's console — output and
/// input stream straight through, exactly as under `dotnet exec`, and
/// callers that need capture use the process-global (cref:Console.SetOut(TextWriter))
/// as they always have.
///
/// Cancellation is best-effort and matches the historical evaluator
/// drivers: the token is only observed before the entry point is invoked, so
/// an already-running program cannot be interrupted, and Ctrl+C keeps its
/// process-default behavior in the CLI drivers.
///
/// In-process execution inherits the same hazards the tree-walking
/// evaluator had: (cref:Environment.Exit(int)) in user code terminates
/// the driver, and threads the program spawned may outlive its entry point.
shared class EmittedProgramHost {
    /// Gets the exit code a driver reports when the program threw an
    /// unhandled exception, matching the CLR host's crash exit code
    /// (SIGABRT's 134 on Unix, the CLR exception COMPLUS code on Windows).
    private let _unhandledExceptionExitCode int32 = if OperatingSystem.IsWindows() {
        unchecked(int32(0xE0434352U))
    } else {
        134
    }

    prop UnhandledExceptionExitCode int32 {
        get {
            return _unhandledExceptionExitCode
        }
    }

    /// Renders an unhandled program exception the way the CLR host does for
    /// an emitted executable: `Unhandled exception. ` followed by the
    /// exception text, with the reflection-invoker frames the in-process
    /// invocation appends below the program's own frames trimmed away so the
    /// text matches `dotnet exec` byte-for-byte.
    /// @param unhandledException The unhandled exception from
    /// (cref:EmittedProgramResult.UnhandledException).
    /// @returns The single- or multi-line crash text, without a trailing newline.
    func FormatUnhandledException(unhandledException Exception?) string {
        if unhandledException == nil {
            throw ArgumentNullException("unhandledException")
        }
        let lines = unhandledException.ToString().Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList()
        while lines.Count > 0 && IsReflectionInvokerFrame(lines[^1]) {
            lines.RemoveAt(lines.Count - 1)
        }
        return "Unhandled exception. " + string.Join(Environment.NewLine, lines)
    }

    /// Compiles [`compilation`](paramref) to memory and, when emit
    /// succeeds, executes its entry point in a collectible
    /// (cref:AssemblyLoadContext) which is unloaded before returning.
    /// @param compilation The compilation to emit and run.
    /// @param referencePaths User-supplied reference assembly paths (`/r:`) made resolvable at runtime; may
    /// be `null`.
    /// @param cancellationToken Best-effort cancellation, observed only before the entry point is invoked.
    /// @returns The emit diagnostics plus the program's exit code or unhandled exception.
    /// @exception OperationCanceledException The token was cancelled before the program was invoked.
    func Run(
        compilation Compilation?,
        referencePaths IReadOnlyList[string]? = nil,
        cancellationToken CancellationToken = default(CancellationToken)
    ) EmittedProgramResult {
        if compilation == nil {
            throw ArgumentNullException("compilation")
        }
        using let peStream = MemoryStream()
        let emitResult = compilation.Emit(peStream)
        if !emitResult.Success {
            return EmittedProgramResult.FromFailedEmit(emitResult.Diagnostics)
        }
        cancellationToken.ThrowIfCancellationRequested()
        let (exitCode, unhandledException, loadContext) = LoadAndInvoke(peStream, referencePaths)
        return EmittedProgramResult.FromExecution(emitResult.Diagnostics, exitCode, unhandledException, loadContext)
    }

    private func IsReflectionInvokerFrame(line string) bool {
        let trimmed = line.TrimStart()
        return trimmed.StartsWith("at System.Reflection.MethodBaseInvoker.", StringComparison.Ordinal) ||
            trimmed.StartsWith("at System.Reflection.RuntimeMethodInfo.Invoke(", StringComparison.Ordinal) ||
            trimmed.StartsWith("at System.Reflection.MethodBase.Invoke(", StringComparison.Ordinal) ||
            trimmed.StartsWith("at System.RuntimeMethodHandle.InvokeMethod(", StringComparison.Ordinal)
    }

    private func LoadAndInvoke(peStream MemoryStream, referencePaths IReadOnlyList[string]?)(
        ExitCode int32,
        UnhandledException Exception?,
        LoadContext WeakReference
    ) {
        let loadContext = AssemblyLoadContext("gsharp-emitted-${Guid.NewGuid():N}", isCollectible: true)
        let weakReference = WeakReference(loadContext)
        let resolver(AssemblyLoadContext, AssemblyName) -> Assembly? = (
            context AssemblyLoadContext,
            assemblyName AssemblyName
        ) -> ResolveDependency(context, assemblyName, referencePaths)
        AddResolvingHandler(loadContext, resolver)
        try {
            peStream.Position = 0
            let assembly = loadContext.LoadFromStream(peStream)
            let entryPoint MethodInfo? = assembly.EntryPoint
            if entryPoint == nil {
                // A declaration-only script emits no runnable statements; the
                // historical drivers report success with exit code 0.
                return (0, nil, weakReference)
            }
            // The CLR host validates the managed entry point's signature
            // before running a single user statement; mirror its check (and
            // its exact crash text) so an invalid Main crashes identically
            // under `dotnet exec` and the in-memory drivers. IsSameAs keeps
            // the issue-#835 typeof-identity guard clean even though these
            // are runtime-loaded (never MetadataLoadContext) types.
            if !entryPoint.ReturnType.IsSameAs(typeof(Void)) && !entryPoint.ReturnType.IsSameAs(typeof(int32)) &&
                !entryPoint
                .ReturnType
                .IsSameAs(typeof(uint32)) {
                let invalidEntryPoint = MethodAccessException(
                    "Entry point must have a return type of void, integer, or unsigned integer."
                )
                return (UnhandledExceptionExitCode, invalidEntryPoint, weakReference)
            }
            let arguments = if entryPoint.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
            var returnValue object?
            try {
                returnValue = entryPoint.Invoke(nil, arguments)
            } catch (ex TargetInvocationException) when ex.InnerException != nil {
                // The inner exception's stack trace was frozen at the
                // reflection boundary, so it ends at the program's own frames —
                // rendering it reproduces exactly what the CLR host prints
                // for an emitted executable, with no host frames appended.
                return (UnhandledExceptionExitCode, ex.InnerException!!, weakReference)
            } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                return (UnhandledExceptionExitCode, ex, weakReference)
            }
            let exitCode = switch returnValue {
                case value is int32: value
                case value is uint32: unchecked(int32(value))
                default: 0
            }
            return (exitCode, nil, weakReference)
        } finally {
            loadContext.Unload()
        }
    }

    private func AddResolvingHandler(
        loadContext AssemblyLoadContext,
        resolver(AssemblyLoadContext, AssemblyName) -> Assembly?
    ) {
        let resolvingEvent = typeof(AssemblyLoadContext).GetEvent("Resolving")
        resolvingEvent?.AddEventHandler(loadContext, resolver)
    }

    private func ResolveDependency(
        context AssemblyLoadContext,
        assemblyName AssemblyName,
        referencePaths IReadOnlyList[string]?
    ) Assembly? {
        // User-supplied references win over any same-named host assembly so
        // the program binds against exactly what it was compiled against.
        if referencePaths != nil && assemblyName.Name != nil {
            var match string? = nil
            for path in referencePaths {
                if !string.IsNullOrWhiteSpace(path) && string.Equals(
                    Path.GetFileNameWithoutExtension(path),
                    assemblyName.Name,
                    StringComparison.OrdinalIgnoreCase
                ) &&
                    File.Exists(path) {
                    match = path
                    break
                }
            }
            if match != nil {
                return context.LoadFromAssemblyPath(Path.GetFullPath(match))
            }
        }
        // Framework and transitive dependencies fall back to the default
        // context, mirroring how the emitted program would bind under the
        // shared-framework host.
        try {
            return Assembly.Load(assemblyName)
        } catch (FileNotFoundException) {
            return nil
        } catch (FileLoadException) {
            return nil
        } catch (BadImageFormatException) {
            return nil
        }
    }
}

// <copyright file="InteractiveSessionHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import SystemObject = System.Object

/// Execution host for the interactive REPL (ADR-0156 Phase 2). Owns one
/// collectible (cref:AssemblyLoadContext) for the whole session: each
/// submission's emitted PE loads into it and stays loaded — submission
/// `N+1` references `N`'s assembly and its live static state, so
/// the unit of unload is the session, reclaimed by (cref:Reset) or
/// (cref:Dispose). Framework dependencies resolve through the default
/// load context; sibling submissions resolve by name from the session's own
/// loaded set; user-supplied reference assemblies (`/r:`) resolve from
/// their explicit paths.
class InteractiveSessionHost : IDisposable {
    private let gate object = SystemObject()
    private let referencePaths IReadOnlyList[string]
    private var loadedByName Dictionary[string, Assembly]?
    private var loadContext AssemblyLoadContext?
    private var disposed bool

    /// Initializes a new instance of the (cref:InteractiveSessionHost) class.
    /// @param referencePaths User-supplied reference assembly paths (`/r:`) made resolvable at runtime; may
    /// be `null`.
    init(referencePaths IReadOnlyList[string]? = nil) {
        this.referencePaths = referencePaths ?? Array.Empty[string]()
        CreateLoadContext()
    }

    /// Loads a submission's emitted PE bytes into the session context and
    /// invokes its entry point (when one exists — a declarations-only
    /// submission has none and simply loads). The assembly stays loaded for
    /// the rest of the session either way; a submission whose entry point
    /// threw keeps whatever side effects it already applied, exactly like the
    /// historical evaluator's partial-state behavior.
    /// @param peImage The emitted PE image.
    /// @param assemblyName The submission assembly's simple name (used for sibling resolution).
    /// @returns The loaded assembly plus the entry point's outcome.
    func RunSubmission(peImage[]?uint8, assemblyName string) SubmissionRunResult {
        if peImage == nil {
            throw ArgumentNullException("peImage")
        }
        ObjectDisposedException.ThrowIf(disposed, this)
        var assembly Assembly
        lock gate {
            using let stream = MemoryStream(peImage, writable: false)
            // loadContext is assigned in the constructor and cleared only by
            // Dispose; a disposed host is not reused.
            assembly = loadContext!!.LoadFromStream(stream)
            if !string.IsNullOrEmpty(assemblyName) {
                loadedByName!![assemblyName] = assembly
            }
        }
        let entryPoint MethodInfo? = assembly.EntryPoint
        if entryPoint == nil {
            return SubmissionRunResult(assembly, returnValue: nil, unhandledException: nil)
        }
        let arguments = if entryPoint.GetParameters().Length == 0 {
            default([]?object)
        } else {
            []object{Array.Empty[string]()}
        }
        try {
            let returnValue = entryPoint.Invoke(nil, arguments)
            return SubmissionRunResult(assembly, returnValue, unhandledException: nil)
        } catch (ex TargetInvocationException) when ex.InnerException != nil {
            return SubmissionRunResult(assembly, returnValue: nil, unhandledException: ex.InnerException)
        } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
            return SubmissionRunResult(assembly, returnValue: nil, unhandledException: ex)
        }
    }

    /// Reads a public static field from a loaded submission assembly via
    /// runtime reflection — the value channel for the REPL's cell echo
    /// (the synthesized `<Result>$` field) and the state sidebar's
    /// values column. Returns `null` when the type or field
    /// does not exist.
    /// @param assembly The loaded submission assembly.
    /// @param typeFullName The declaring type's metadata full name (e.g. `gsi3.<Program>`).
    /// @param fieldName The static field's name.
    /// @returns The field's current value, or `null`.
    func ReadStaticField(assembly Assembly?, typeFullName string, fieldName string) object? {
        if assembly == nil {
            return nil
        }
        try {
            let type = assembly.GetType(typeFullName, throwOnError: false)
            let field = type?.GetField(fieldName, BindingFlags.Public | BindingFlags.Static)
            return field?.GetValue(nil)
        } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
            return nil
        }
    }

    /// Unloads the session's load context (letting real deinitializers run
    /// when the finalizer queue drains after collection) and starts a fresh
    /// one, discarding every loaded submission.
    func Reset() {
        lock gate {
            ObjectDisposedException.ThrowIf(disposed, this)
            // ThrowIf above rules out the disposed state, the only one in
            // which loadContext is null.
            loadContext!!.Unload()
            CreateLoadContext()
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        lock gate {
            if disposed {
                return
            }
            disposed = true
            // The `disposed` guard above returns early on a second call, so
            // loadContext is still the one the constructor assigned.
            loadContext!!.Unload()
            loadContext = nil
            loadedByName = nil
        }
    }

    private func CreateLoadContext() {
        loadedByName = Dictionary[string, Assembly](StringComparer.OrdinalIgnoreCase)
        loadContext = AssemblyLoadContext("gsi-session-${Guid.NewGuid():N}", isCollectible: true)
        let resolver(AssemblyLoadContext, AssemblyName) -> Assembly? = (
            context AssemblyLoadContext,
            assemblyName AssemblyName
        ) -> ResolveDependency(context, assemblyName)
        AddResolvingHandler(loadContext!!, resolver)
    }

    private func ResolveDependency(context AssemblyLoadContext, assemblyName AssemblyName) Assembly? {
        if assemblyName.Name == nil {
            return nil
        }
        // Sibling submissions resolve from the session's own loaded set.
        lock gate {
            if loadedByName != nil && loadedByName!!.TryGetValue(assemblyName.Name!!, out var sibling) {
                return sibling
            }
        }
        // User-supplied references win over any same-named host assembly so
        // the submission binds against exactly what it was compiled against.
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
        // Framework and transitive dependencies fall back to the default
        // context, mirroring EmittedProgramHost's script-mode resolution.
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

    shared {
        private func AddResolvingHandler(
            context AssemblyLoadContext,
            resolver(AssemblyLoadContext, AssemblyName) -> Assembly?
        ) {
            let resolvingEvent = typeof(AssemblyLoadContext).GetEvent("Resolving")
            resolvingEvent?.AddEventHandler(context, resolver)
        }
    }
}

/// The outcome of running one submission: the loaded assembly (always
/// non-null — a submission that threw stays loaded), the entry point's
/// return value, and the unhandled exception when the submission threw.
class SubmissionRunResult {
    internal init(assembly Assembly, returnValue object?, unhandledException Exception?) {
        Assembly = assembly
        ReturnValue = returnValue
        UnhandledException = unhandledException
    }

    /// Gets the loaded submission assembly.
    prop Assembly Assembly {
        get;
    }

    /// Gets the entry point's return value (`null` for void or on failure).
    prop ReturnValue object? {
        get;
    }

    /// Gets the exception the submission's entry point threw, or `null` on success.
    prop UnhandledException Exception? {
        get;
    }
}

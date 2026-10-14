// <copyright file="EmittedOracleResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection

/// The observable outcome of one (cref:EmittedOracle.Evaluate(string))
/// run: the same assertion surface tests historically consumed from
/// `Compilation.Evaluate`'s (cref:EvaluationResult)
/// ((cref:Diagnostics) + (cref:Value)), plus the captured
/// console streams and the emitted program's exit protocol.
class EmittedOracleResult {
    internal init(
        diagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic],
        value object?,
        output string,
        errorOutput string,
        exitCode int32,
        unhandledException Exception?,
        loadContext WeakReference?,
        assembly Assembly? = nil
    ) {
        Diagnostics = diagnostics
        Value = value
        Output = output
        ErrorOutput = errorOutput
        ExitCode = exitCode
        UnhandledException = unhandledException
        LoadContext = loadContext
        Assembly = assembly
    }

    /// Gets the diagnostics, shaped exactly like `Compilation.Evaluate`'s:
    /// on compile failure, all warnings followed by all errors (the program
    /// never ran); on a runtime failure, the compile warnings plus one
    /// synthesized `GS9999` error carrying the unhandled exception's
    /// message (the historical evaluator's uncaught-exception protocol);
    /// warnings only otherwise. The interpreter-boundary diagnostics
    /// (GS0510/GS0511/GS0513/GS0514) never appear — those constructs simply
    /// work under emitted execution (ADR-0156).
    prop Diagnostics ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] {
        get;
    }

    /// Gets the program's result value — the trailing expression (or trailing
    /// variable declaration) value captured into the synthesized
    /// `<Result>$` submission global, falling back to the entry
    /// point's declared `int`/`uint` return value, otherwise
    /// `null`. Equivalent to (cref:EvaluationResult.Value)
    /// for the canonical trailing-expression test shape.
    ///
    /// Identity caveat: a value whose type is <em>declared by the
    /// evaluated source</em> is an instance of a type living in the run's own
    /// collectible (cref:System.Runtime.Loader.AssemblyLoadContext) —
    /// `is`/cast checks against test-side types will not match (only
    /// framework-typed values, e.g. `int`/`string`/`bool`, unify
    /// with the test's type identities). Reflect on it, or assert on
    /// (cref:ValueText) / (cref:Output) instead.
    ///
    /// Lifetime: the load context's unload is <em>initiated</em> before
    /// the result is returned, but a collectible context is only reclaimed once
    /// nothing references it — holding this value keeps it (and its type) fully
    /// usable for assertions; there is no use-after-unload hazard.
    prop Value object? {
        get;
    }

    /// Gets (cref:Value) rendered via (cref:object.ToString)
    /// (invariant rendering for the null case: `null` stays
    /// `null`). The assertion-friendly channel for values of
    /// submission-declared types, whose CLR identity lives in the run's own
    /// load context.
    prop ValueText string? -> Value?.ToString()

    /// Gets everything the program wrote to standard output, captured for the
    /// duration of the run. Empty when the program never ran (compile failure)
    /// or wrote nothing. Newlines are the platform's
    /// ((cref:Environment.NewLine)), matching a test-owned
    /// (cref:System.IO.StringWriter) capture around
    /// `Compilation.Evaluate`.
    prop Output string {
        get;
    }

    /// Gets everything the program wrote to standard error, captured for the
    /// duration of the run.
    prop ErrorOutput string {
        get;
    }

    /// Gets the emitted program's exit code: the entry point's `int`/`uint`
    /// return value (otherwise 0), 1 on compile failure, or
    /// (cref:GSharp.Core.CodeAnalysis.Execution.EmittedProgramHost.UnhandledExceptionExitCode)
    /// when the program threw.
    prop ExitCode int32 {
        get;
    }

    /// Gets the unhandled exception the program threw, unwrapped from the
    /// reflection invocation boundary, or `null`. Richer than
    /// the synthesized GS9999 diagnostic when a test wants the exception type
    /// or full text.
    prop UnhandledException Exception? {
        get;
    }

    /// Gets a weak reference to the run's collectible load context (unload
    /// already initiated). Oracle-test seam for asserting reclaimability;
    /// product tests should not consume this.
    internal prop LoadContext WeakReference? {
        get;
    }

    /// Gets the executed submission assembly (`null` when the
    /// program never ran). Holding the result keeps it loaded; see the
    /// lifetime note on (cref:Value).
    internal prop Assembly Assembly? {
        get;
    }

    /// Reads a top-level global's post-run value by name — the emitted
    /// equivalent of reading the historical evaluator's variables dictionary
    /// after `Compilation.Evaluate`: top-level `var`/`let`
    /// emit as static fields on the submission's `<Program>`
    /// container. Returns `null` when the program never ran
    /// or no such global exists. The (cref:Value) identity caveat
    /// applies to values of submission-declared types.
    /// @param name The top-level variable's source name.
    /// @returns The global's current value, or `null`.
    func ReadGlobal(name string?) object? {
        if string.IsNullOrEmpty(name) {
            return nil
        }
        for field in EnumerateGlobalFields() {
            if string.Equals(field.Name, name, StringComparison.Ordinal) {
                return field.GetValue(nil)
            }
        }
        return nil
    }

    /// Reads every top-level global's post-run value by name — the emitted
    /// equivalent of the historical evaluator's whole variables dictionary
    /// after `Compilation.Evaluate`. Synthesized submission fields
    /// (`<Result>$` and friends) are excluded. Empty when the
    /// program never ran. The (cref:Value) identity caveat applies to
    /// values of submission-declared types.
    /// @returns A name-to-value map of the top-level globals.
    func ReadGlobals() IReadOnlyDictionary[string, object?] {
        let globals = Dictionary[string, object?](StringComparer.Ordinal)
        for field in EnumerateGlobalFields() {
            if field.Name.IndexOf('<') >= 0 {
                // Compiler-synthesized (e.g. the <Result>$ capture) — not a
                // source global.
                continue
            }
            globals[field.Name] = field.GetValue(nil)
        }
        return globals
    }

    private func EnumerateGlobalFields() sequence[FieldInfo] {
        if Assembly == nil {
            yield break
        }
        var types[]Type?
        try {
            types = Assembly!!.GetTypes()
        } catch (ex ReflectionTypeLoadException) {
            types = ex.Types
        }
        for type in types {
            if type == nil || !string.Equals(type.Name, SubmissionImports.ProgramTypeName, StringComparison.Ordinal) {
                continue
            }
            for field in type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static) {
                yield field
            }
        }
    }
}

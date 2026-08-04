// <copyright file="EmittedOracleResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Tests;

/// <summary>
/// The observable outcome of one <see cref="EmittedOracle.Evaluate(string)"/>
/// run: the same assertion surface tests historically consumed from
/// <c>Compilation.Evaluate</c>'s <see cref="EvaluationResult"/>
/// (<see cref="Diagnostics"/> + <see cref="Value"/>), plus the captured
/// console streams and the emitted program's exit protocol.
/// </summary>
public sealed class EmittedOracleResult
{
    internal EmittedOracleResult(
        ImmutableArray<Diagnostic> diagnostics,
        object value,
        string output,
        string errorOutput,
        int exitCode,
        Exception unhandledException,
        WeakReference loadContext,
        Assembly assembly = null)
    {
        Diagnostics = diagnostics;
        Value = value;
        Output = output;
        ErrorOutput = errorOutput;
        ExitCode = exitCode;
        UnhandledException = unhandledException;
        LoadContext = loadContext;
        Assembly = assembly;
    }

    /// <summary>
    /// Gets the diagnostics, shaped exactly like <c>Compilation.Evaluate</c>'s:
    /// on compile failure, all warnings followed by all errors (the program
    /// never ran); on a runtime failure, the compile warnings plus one
    /// synthesized <c>GS9999</c> error carrying the unhandled exception's
    /// message (the historical evaluator's uncaught-exception protocol);
    /// warnings only otherwise. The interpreter-boundary diagnostics
    /// (GS0510/GS0511/GS0513/GS0514) never appear — those constructs simply
    /// work under emitted execution (ADR-0156).
    /// </summary>
    public ImmutableArray<Diagnostic> Diagnostics { get; }

    /// <summary>
    /// Gets the program's result value — the trailing expression (or trailing
    /// variable declaration) value captured into the synthesized
    /// <c>&lt;Result&gt;$</c> submission global, falling back to the entry
    /// point's declared <c>int</c>/<c>uint</c> return value, otherwise
    /// <see langword="null"/>. Equivalent to <see cref="EvaluationResult.Value"/>
    /// for the canonical trailing-expression test shape.
    /// <para>Identity caveat: a value whose type is <em>declared by the
    /// evaluated source</em> is an instance of a type living in the run's own
    /// collectible <see cref="System.Runtime.Loader.AssemblyLoadContext"/> —
    /// <c>is</c>/cast checks against test-side types will not match (only
    /// framework-typed values, e.g. <c>int</c>/<c>string</c>/<c>bool</c>, unify
    /// with the test's type identities). Reflect on it, or assert on
    /// <see cref="ValueText"/> / <see cref="Output"/> instead.</para>
    /// <para>Lifetime: the load context's unload is <em>initiated</em> before
    /// the result is returned, but a collectible context is only reclaimed once
    /// nothing references it — holding this value keeps it (and its type) fully
    /// usable for assertions; there is no use-after-unload hazard.</para>
    /// </summary>
    public object Value { get; }

    /// <summary>
    /// Gets <see cref="Value"/> rendered via <see cref="object.ToString"/>
    /// (invariant rendering for the null case: <see langword="null"/> stays
    /// <see langword="null"/>). The assertion-friendly channel for values of
    /// submission-declared types, whose CLR identity lives in the run's own
    /// load context.
    /// </summary>
    public string ValueText => Value?.ToString();

    /// <summary>
    /// Gets everything the program wrote to standard output, captured for the
    /// duration of the run. Empty when the program never ran (compile failure)
    /// or wrote nothing. Newlines are the platform's
    /// (<see cref="Environment.NewLine"/>), matching a test-owned
    /// <see cref="System.IO.StringWriter"/> capture around
    /// <c>Compilation.Evaluate</c>.
    /// </summary>
    public string Output { get; }

    /// <summary>
    /// Gets everything the program wrote to standard error, captured for the
    /// duration of the run.
    /// </summary>
    public string ErrorOutput { get; }

    /// <summary>
    /// Gets the emitted program's exit code: the entry point's <c>int</c>/<c>uint</c>
    /// return value (otherwise 0), 1 on compile failure, or
    /// <see cref="GSharp.Core.CodeAnalysis.Execution.EmittedProgramHost.UnhandledExceptionExitCode"/>
    /// when the program threw.
    /// </summary>
    public int ExitCode { get; }

    /// <summary>
    /// Gets the unhandled exception the program threw, unwrapped from the
    /// reflection invocation boundary, or <see langword="null"/>. Richer than
    /// the synthesized GS9999 diagnostic when a test wants the exception type
    /// or full text.
    /// </summary>
    public Exception UnhandledException { get; }

    /// <summary>
    /// Gets a weak reference to the run's collectible load context (unload
    /// already initiated). Oracle-test seam for asserting reclaimability;
    /// product tests should not consume this.
    /// </summary>
    internal WeakReference LoadContext { get; }

    /// <summary>
    /// Gets the executed submission assembly (<see langword="null"/> when the
    /// program never ran). Holding the result keeps it loaded; see the
    /// lifetime note on <see cref="Value"/>.
    /// </summary>
    internal Assembly Assembly { get; }

    /// <summary>
    /// Reads a top-level global's post-run value by name — the emitted
    /// equivalent of reading the historical evaluator's variables dictionary
    /// after <c>Compilation.Evaluate</c>: top-level <c>var</c>/<c>let</c>
    /// emit as static fields on the submission's <c>&lt;Program&gt;</c>
    /// container. Returns <see langword="null"/> when the program never ran
    /// or no such global exists. The <see cref="Value"/> identity caveat
    /// applies to values of submission-declared types.
    /// </summary>
    /// <param name="name">The top-level variable's source name.</param>
    /// <returns>The global's current value, or <see langword="null"/>.</returns>
    public object ReadGlobal(string name)
    {
        if (Assembly is null || string.IsNullOrEmpty(name))
        {
            return null;
        }

        Type[] types;
        try
        {
            types = Assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            types = ex.Types;
        }

        foreach (var type in types)
        {
            if (type is null || !string.Equals(type.Name, SubmissionImports.ProgramTypeName, StringComparison.Ordinal))
            {
                continue;
            }

            var field = type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (field is not null)
            {
                return field.GetValue(null);
            }
        }

        return null;
    }
}

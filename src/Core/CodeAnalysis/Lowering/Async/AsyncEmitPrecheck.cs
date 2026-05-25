// <copyright file="AsyncEmitPrecheck.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Pre-emit gate that reports a clean diagnostic for every <c>async</c>
/// function in the bound program. Until the full async state-machine
/// rewriter and emitter pipeline lands (ADR-0023 / issue #52), the emitter
/// cannot produce a valid PE for any <c>async</c> method — historically it
/// silently produced IL that throws <c>InvalidProgramException</c> at
/// runtime. This pass converts that silent failure into a clean compile-time
/// error so users see a useful message instead of a runtime crash.
/// </summary>
/// <remarks>
/// <para>The interpreter retains full async support and is unaffected by
/// this gate (interpreter execution does not go through <see cref="Emit"/>).
/// The aspirational sample harness (<c>AspirationalSamplesTests</c>) and the
/// compiler conformance harness (<c>SampleConformanceTests</c>) already skip
/// async samples for emit per ADR-0022/0023.</para>
/// <para>The gate is removed (or relaxed to a no-op for the supported subset)
/// piece-by-piece as the rewriter slices land:</para>
/// <list type="number">
/// <item><description>First slice (this PR): always block.</description></item>
/// <item><description>State-machine rewriter slice: allow async methods
/// whose state machine has been successfully synthesized.</description></item>
/// <item><description>Iterator rewriter slice: allow async-iterator
/// methods.</description></item>
/// </list>
/// </remarks>
public static class AsyncEmitPrecheck
{
    /// <summary>The diagnostic message reported for each async function the emitter cannot handle yet.</summary>
    public const string AsyncEmitNotImplementedMessage =
        "Emitting 'async' functions is not yet implemented; tracked in https://github.com/DavidObando/gsharp/issues/52. " +
        "Use the interpreter for async code until the state-machine emitter lands.";

    /// <summary>
    /// Walks <paramref name="program"/> and returns one diagnostic per
    /// <c>async</c> function. Returns an empty array when the program has
    /// no async functions.
    /// </summary>
    /// <param name="program">The bound program (post-binding, pre-emit).</param>
    /// <returns>The diagnostics to surface; empty when emit may proceed.</returns>
    public static ImmutableArray<Diagnostic> Check(BoundProgram program)
    {
        if (program == null)
        {
            return ImmutableArray<Diagnostic>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<Diagnostic>();

        foreach (var function in program.Functions.Keys)
        {
            if (!function.IsAsync)
            {
                continue;
            }

            var location = LocateAsyncFunction(function);
            builder.Add(new Diagnostic(location, AsyncEmitNotImplementedMessage));
        }

        if (program.EntryPoint is { } entry && entry.IsAsync && !program.Functions.ContainsKey(entry))
        {
            builder.Add(new Diagnostic(LocateAsyncFunction(entry), AsyncEmitNotImplementedMessage));
        }

        return builder.ToImmutable();
    }

    private static TextLocation LocateAsyncFunction(FunctionSymbol function)
    {
        var declaration = function.Declaration;
        if (declaration == null)
        {
            return new TextLocation(SourceText.From(string.Empty), new TextSpan(0, 0));
        }

        var anchor = declaration.AsyncModifier ?? declaration.Identifier;
        return anchor?.Location ?? declaration.Location;
    }
}

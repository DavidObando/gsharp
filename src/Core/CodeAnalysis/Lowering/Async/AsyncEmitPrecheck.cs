// <copyright file="AsyncEmitPrecheck.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Safety-net gate that prevents the emitter from crashing on async
/// functions whose state-machine synthesis failed (e.g. the awaitable's
/// method-builder type could not be resolved). When state-machine
/// synthesis succeeds — the normal path — this pass is a no-op.
/// </summary>
/// <remarks>
/// <para>The gate inspects <see cref="Symbols.FunctionSymbol.StateMachineType"/>
/// which is populated by the async rewriter. A <c>null</c> value indicates
/// synthesis failure and triggers a clean compile-time diagnostic rather than
/// a runtime <c>InvalidProgramException</c>.</para>
/// </remarks>
public static class AsyncEmitPrecheck
{
    /// <summary>The diagnostic message reported when an async function's state-machine synthesis failed.</summary>
    public const string AsyncStateMachineUnavailableMessage =
        "Could not synthesize the state machine for this async function; the awaitable's method-builder type could not be resolved. " +
        "See https://github.com/DavidObando/gsharp/issues/52.";

    /// <summary>
    /// Walks <paramref name="program"/> and returns one diagnostic per
    /// <c>async</c> function whose state-machine synthesis failed
    /// (i.e. <c>StateMachineType</c> is <c>null</c> after the rewriter ran).
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

        foreach (var pair in program.Functions)
        {
            var function = pair.Key;
            if (!function.IsAsync)
            {
                continue;
            }

            // Async iterators are now supported — no gate needed.
            if (AsyncIteratorDetection.IsAsyncIteratorFunction(function, pair.Value))
            {
                continue;
            }

            // Gate: async methods that have no successfully synthesized state machine
            // (e.g. builder resolution failed). These remain blocked.
            if (function.StateMachineType == null)
            {
                var location = LocateAsyncFunction(function);
                builder.Add(new Diagnostic(location, "GS0190", DiagnosticSeverity.Error, AsyncStateMachineUnavailableMessage));
                continue;
            }
        }

        if (program.EntryPoint is { } entry && entry.IsAsync && !program.Functions.ContainsKey(entry))
        {
            if (entry.StateMachineType == null)
            {
                builder.Add(new Diagnostic(LocateAsyncFunction(entry), "GS0190", DiagnosticSeverity.Error, AsyncStateMachineUnavailableMessage));
            }
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

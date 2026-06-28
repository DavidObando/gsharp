#nullable disable

// <copyright file="AsyncCaptureWalker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Computes the set of variables that the async state-machine rewriter must
/// hoist into fields on the synthesized state-machine type (see
/// <c>~/roslyn-async.md</c> §5). Roslyn's production implementation runs a
/// definite-assignment pass to hoist only locals that are live across a
/// suspension point. GSharp's V1 takes the simpler conservative rule used by
/// Roslyn's Debug-mode build: every parameter and every referenced
/// user-declared local in an async method body is hoisted, regardless of
/// live-range analysis. This may over-hoist (a strictly intra-statement
/// scratch local that never crosses an <c>await</c> still becomes a field)
/// but is always correct, never under-hoists, and avoids pulling in a full
/// data-flow framework before the state machine itself works.
/// </summary>
/// <remarks>
/// <para>The walker explicitly excludes:</para>
/// <list type="bullet">
/// <item><description>Spill-temp locals introduced by the spill spiller
/// (spec §7) — they are managed in a separate hoist set keyed by the spill
/// expression they represent and registered by the spiller, not here.</description></item>
/// </list>
/// <para>Spill-temp detection is by name prefix (<see cref="GeneratedNames.SpillTempPrefix"/>)
/// because GSharp does not (yet) carry a synthesized-kind tag on
/// <see cref="LocalVariableSymbol"/>. The spill spiller will use the same
/// prefix when it emits its locals.</para>
/// <para>For <c>this</c> capture: the bound tree does not currently
/// distinguish instance-member field access from local access at the rewriter
/// level, so the rewriter treats every instance method as capturing
/// <c>this</c>. The walker itself does not need to detect receiver
/// references — the orchestrator sets the corresponding flag based on the
/// kickoff method's receiver.</para>
/// </remarks>
public static class AsyncCaptureWalker
{
    /// <summary>
    /// Walks <paramref name="body"/> and returns the hoist set.
    /// </summary>
    /// <param name="body">The lowered async method body.</param>
    /// <param name="parameters">The kickoff method's parameters.</param>
    /// <returns>The set of parameters and locals to hoist, in stable
    /// insertion order. Parameters precede locals; within each group, order
    /// matches first-encounter order in the tree walk so the synthesized
    /// type's fields have a deterministic layout.</returns>
    public static HoistResult Analyze(BoundStatement body, ImmutableArray<ParameterSymbol> parameters)
    {
        var collector = new ReferenceCollector();
        collector.Visit(body);

        var orderedLocals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
        foreach (var local in collector.Locals)
        {
            if (local is ParameterSymbol)
            {
                continue;
            }

            if (local.Name.StartsWith(GeneratedNames.SpillTempPrefix, System.StringComparison.Ordinal))
            {
                continue;
            }

            // Skip ref locals (ByRef-typed) — they cannot be hoisted into fields.
            // The RefInitializationHoister eliminates them before this walker runs;
            // this check is a safety net.
            if (local.Type is ByRefTypeSymbol)
            {
                continue;
            }

            // Skip ref-struct (ByRef-like) locals — e.g. the synthesized
            // DefaultInterpolatedStringHandler emitted for interpolated strings
            // (ADR-0055 / issue #368). A ByRef-like type cannot be an instance
            // field, so it must stay a MoveNext local. This is safe because such
            // locals are always constructed and fully consumed within a single
            // expression and never stay live across an await suspension.
            if (local.Type?.ClrType?.IsByRefLike == true)
            {
                continue;
            }

            orderedLocals.Add(local);
        }

        return new HoistResult(parameters, orderedLocals.ToImmutable());
    }

    /// <summary>
    /// The set of variables to hoist onto the synthesized state-machine type
    /// for one kickoff async method.
    /// </summary>
    public sealed class HoistResult
    {
        /// <summary>Initializes a new instance of the <see cref="HoistResult"/> class.</summary>
        /// <param name="parameters">Parameters to hoist (always all of them in V1).</param>
        /// <param name="locals">User-declared locals to hoist.</param>
        public HoistResult(ImmutableArray<ParameterSymbol> parameters, ImmutableArray<LocalVariableSymbol> locals)
        {
            Parameters = parameters;
            Locals = locals;
        }

        /// <summary>Gets the parameters to hoist.</summary>
        public ImmutableArray<ParameterSymbol> Parameters { get; }

        /// <summary>Gets the user-declared locals to hoist, in first-encounter order.</summary>
        public ImmutableArray<LocalVariableSymbol> Locals { get; }
    }

    private sealed class ReferenceCollector : BoundTreeRewriter
    {
        private readonly HashSet<LocalVariableSymbol> seen = new HashSet<LocalVariableSymbol>();
        private readonly List<LocalVariableSymbol> orderedLocals = new List<LocalVariableSymbol>();

        public IReadOnlyList<LocalVariableSymbol> Locals => orderedLocals;

        public void Visit(BoundStatement node)
        {
            if (node != null)
            {
                RewriteStatement(node);
            }
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
        {
            Record(node.Variable);
            return node;
        }

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            Record(node.Variable);
            return base.RewriteAssignmentExpression(node);
        }

        protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
        {
            Record(node.Variable);
            return base.RewriteVariableDeclaration(node);
        }

        private void Record(VariableSymbol variable)
        {
            if (variable is LocalVariableSymbol local && seen.Add(local))
            {
                orderedLocals.Add(local);
            }
        }
    }
}

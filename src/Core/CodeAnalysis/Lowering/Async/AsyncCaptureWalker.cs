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
            // Issue #1919: use the metadata-load-safe TypeSymbol.IsByRefLike
            // helper rather than reading Type.IsByRefLike directly. A
            // delegate-typed local (e.g. a `Func[T, Task[T]]` backing an async
            // lambda variable) whose ClrType was built by mixing the host's
            // live `typeof(Func<,>)` with a MetadataLoadContext-projected type
            // argument (gsc's `/reference:` mode) realizes as a
            // `System.Reflection.Emit.TypeBuilderInstantiation` — an
            // intentionally-tolerated cross-context artifact (see
            // Binding/Conversion.cs) whose `IsByRefLike` throws
            // NotSupportedException instead of returning a real answer.
            if (TypeSymbol.IsByRefLike(local.Type))
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

        /// <summary>
        /// Issue #2331 (deferred half): a parameter or local whose only
        /// reference anywhere in this async body is inside a nested lambda —
        /// including a lambda nested inside that lambda — must still
        /// contribute to the hoist set. Otherwise its value does not survive
        /// suspension across an intervening <c>await</c>: a resumed
        /// <c>MoveNext</c> call is a fresh invocation of the same method, so
        /// any variable that was not hoisted into a state-machine field is
        /// re-initialized to the CLR default instead of retaining the value
        /// it held before suspension.
        /// </summary>
        /// <remarks>
        /// <see cref="BoundTreeRewriter"/> intentionally treats a function
        /// literal as an opaque leaf (its body is a separate lexical scope),
        /// so without this override the walk above never reaches a variable
        /// read/written only inside a nested lambda body. Blindly descending
        /// into <c>node.Body</c> with <em>this</em> walker would be wrong: it
        /// would also invoke <see cref="RewriteVariableDeclaration"/> for
        /// locals the lambda itself declares, incorrectly hoisting
        /// lambda-owned state into the outer async method's state machine
        /// and breaking the lambda's own lexical scope.
        /// <para>
        /// Instead, this reuses the capture metadata the binder already
        /// computed: <see cref="BoundFunctionLiteralExpression.CapturedVariables"/>
        /// lists every outer-scope variable the lambda (or any lambda
        /// transitively nested within it) needs, because
        /// <c>LambdaBinder.CapturedVariableCollector.RewriteFunctionLiteralExpression</c>
        /// already propagates a nested literal's own captures up into every
        /// enclosing literal's list (issue #503) — the exact mechanism
        /// <see cref="Lowering.CaptureBoxingRewriter"/>'s own capture walker
        /// relies on for the same reason. <see cref="LambdaCaptureCollector"/>
        /// additionally recurses defensively (mirroring
        /// <see cref="Lowering.CaptureBoxingRewriter"/>'s walker) using a
        /// dedicated helper that itself never records a variable declaration,
        /// so a lambda's own locals are still never hoisted even if a future
        /// binder change stops fully flattening the capture list.
        /// </para>
        /// </remarks>
        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            foreach (var captured in LambdaCaptureCollector.Collect(node))
            {
                Record(captured);
            }

            return node;
        }

        private void Record(VariableSymbol variable)
        {
            if (variable is LocalVariableSymbol local && seen.Add(local))
            {
                orderedLocals.Add(local);
            }
        }
    }

    /// <summary>
    /// Collects the set of outer-scope variables that a lambda literal — or
    /// any lambda transitively nested inside its body — captures, using only
    /// the binder-computed <see cref="BoundFunctionLiteralExpression.CapturedVariables"/>
    /// metadata on each literal it visits (never a lambda's own local
    /// declarations or parameter reads). Mirrors
    /// <c>CaptureBoxingRewriter.CaptureWalker</c>'s defensive recursion (see
    /// #567) for the same reason: the binder already flattens transitive
    /// captures onto every enclosing literal (#503), so the recursion below
    /// is normally a no-op, but keeps this collector correct if that
    /// invariant ever changes.
    /// </summary>
    private sealed class LambdaCaptureCollector : BoundTreeRewriter
    {
        private readonly HashSet<VariableSymbol> sink = new HashSet<VariableSymbol>();

        /// <summary>Collects the transitive capture set for <paramref name="root"/>.</summary>
        /// <param name="root">The lambda literal to start from.</param>
        /// <returns>Every outer-scope variable <paramref name="root"/> or any
        /// lambda nested within it needs.</returns>
        public static IReadOnlyCollection<VariableSymbol> Collect(BoundFunctionLiteralExpression root)
        {
            var collector = new LambdaCaptureCollector();
            collector.VisitLiteral(root);
            return collector.sink;
        }

        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            VisitLiteral(node);
            return node;
        }

        private void VisitLiteral(BoundFunctionLiteralExpression node)
        {
            foreach (var captured in node.CapturedVariables)
            {
                sink.Add(captured);
            }

            // Recurse purely to reach any further-nested BoundFunctionLiteralExpression
            // node (via this class's own RewriteFunctionLiteralExpression override
            // above). Unlike ReferenceCollector, this walker never overrides
            // RewriteVariableDeclaration/RewriteVariableExpression/RewriteAssignmentExpression,
            // so visiting the lambda's own statements cannot record its own
            // locals or parameters as captures of the enclosing async method.
            RewriteStatement(node.Body);
        }
    }
}

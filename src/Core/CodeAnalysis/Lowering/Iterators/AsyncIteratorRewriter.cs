// <copyright file="AsyncIteratorRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable CS1591
#pragma warning disable SA1028
#pragma warning disable SA1116
#pragma warning disable SA1117
#pragma warning disable SA1201
#pragma warning disable SA1202
#pragma warning disable SA1515
#pragma warning disable SA1611
#pragma warning disable SA1615
#pragma warning disable SA1623

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Iterators;

/// <summary>
/// Rewrites async iterator functions (explicitly async or containing <c>yield</c>, and returning
/// <c>IAsyncEnumerable&lt;T&gt;</c> or <c>IAsyncEnumerator&lt;T&gt;</c>)
/// into state-machine classes. Combines the yield-lowering of
/// <see cref="IteratorRewriter"/> with the await-lowering of
/// <see cref="AsyncStateMachineRewriter"/>.
/// </summary>
public static class AsyncIteratorRewriter
{
    /// <summary>
    /// Scans the bound program for async iterator functions and builds rewrite plans.
    /// </summary>
    public static AsyncIteratorRewriteResult Rewrite(BoundProgram program)
    {
        if (program == null)
        {
            throw new ArgumentNullException(nameof(program));
        }

        var plans = ImmutableArray.CreateBuilder<AsyncIteratorPlan>();

        foreach (var pair in program.Functions.OrderBy(p => p.Key.Name, StringComparer.Ordinal))
        {
            var function = pair.Key;
            var body = pair.Value;

            if (!AsyncIteratorDetection.IsAsyncIteratorFunction(function, body))
            {
                continue;
            }

            var elementType = GetAsyncIteratorElementType(function.Type);
            if (elementType == null)
            {
                continue;
            }

            // Issue #2662: lower loops first so synthesized await-for locals
            // and awaits participate in state-machine slot/state allocation.
            var loweredBody = Lowerer.Lower(body);

            // Run async lowering pipeline on the body: exception handler rewrite,
            // spill, ref-hoist. This lifts awaits to statement level.
            var exhRewritten = AsyncExceptionHandlerRewriter.Rewrite(loweredBody);
            var spilledBody = SpillSequenceSpiller.Rewrite(exhRewritten);
            var refHoisted = RefInitializationHoister.Rewrite(spilledBody);

            // Collect yields (for state assignment) and awaits.
            var yieldCollector = new YieldStateCollector();
            yieldCollector.Visit(refHoisted);

            var awaitCollector = new AwaitStateCollector();
            awaitCollector.Visit(refHoisted);

            // Reuse the ordinary async capture analysis so assignment-only
            // loop variables and nested-lambda captures are both hoisted.
            var hoistedLocals = AsyncCaptureWalker
                .Analyze(refHoisted, function.Parameters)
                .Locals
                .Cast<VariableSymbol>()
                .ToImmutableArray();

            // Collect awaiter types for pooled awaiter fields.
            var awaiterTypes = CollectAwaiterTypes(refHoisted);

            var plan = new AsyncIteratorPlan(
                function,
                refHoisted,
                elementType,
                yieldCollector.States,
                awaitCollector.States,
                hoistedLocals,
                awaiterTypes);
            plans.Add(plan);
        }

        return new AsyncIteratorRewriteResult(program, plans.ToImmutable());
    }

    private static TypeSymbol GetAsyncIteratorElementType(TypeSymbol type)
        => AsyncIteratorDetection.GetElementType(type);

    private static ImmutableArray<(Type PoolKey, TypeSymbol FieldType)> CollectAwaiterTypes(BoundStatement body)
    {
        var collector = new AwaiterTypeCollector();
        collector.Visit(body);

        var result = ImmutableArray.CreateBuilder<(Type, TypeSymbol)>();
        var seen = new HashSet<Type>();
        bool hasReferenceAwaiter = false;

        foreach (var awaiterClrType in collector.AwaiterTypes)
        {
            if (awaiterClrType.IsValueType)
            {
                if (seen.Add(awaiterClrType))
                {
                    result.Add((awaiterClrType, TypeSymbol.FromClrType(awaiterClrType)));
                }
            }
            else
            {
                if (!hasReferenceAwaiter)
                {
                    hasReferenceAwaiter = true;
                    result.Add((typeof(object), TypeSymbol.FromClrType(typeof(object))));
                }
            }
        }

        return result.ToImmutable();
    }

    /// <summary>
    /// Assigns monotonically decreasing yield states starting from
    /// <see cref="StateMachineStates.FirstResumableAsyncIteratorState"/> (-4, -5, ...).
    /// </summary>
    public sealed class YieldStateCollector : BoundTreeWalker
    {
        private readonly ResumableStateAllocator allocator = new ResumableStateAllocator();
        private readonly ImmutableDictionary<BoundYieldStatement, int>.Builder states =
            ImmutableDictionary.CreateBuilder<BoundYieldStatement, int>();

        public ImmutableDictionary<BoundYieldStatement, int> States => states.ToImmutable();

        protected override void VisitYieldStatement(BoundYieldStatement node)
        {
            states.Add(node, allocator.AllocateYieldState());
        }
    }

    /// <summary>
    /// Assigns monotonically increasing await states starting from 0.
    /// </summary>
    public sealed class AwaitStateCollector : BoundTreeWalker
    {
        private readonly ResumableStateAllocator allocator = new ResumableStateAllocator();
        private readonly ImmutableDictionary<BoundAwaitExpression, int>.Builder states =
            ImmutableDictionary.CreateBuilder<BoundAwaitExpression, int>();

        public ImmutableDictionary<BoundAwaitExpression, int> States => states.ToImmutable();

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            states.Add(node, allocator.AllocateAwaitState());
            base.VisitAwaitExpression(node);
        }
    }

    private sealed class AwaiterTypeCollector : BoundTreeWalker
    {
        public List<Type> AwaiterTypes { get; } = [];

        protected override void VisitAwaitExpression(BoundAwaitExpression node)
        {
            var awaitableClrType = node.Expression?.Type?.ClrType;
            if (awaitableClrType != null)
            {
                var shape = AwaitableShape.Resolve(awaitableClrType);
                if (shape != null)
                {
                    AwaiterTypes.Add(shape.AwaiterType);
                }
            }

            base.VisitAwaitExpression(node);
        }
    }
}

/// <summary>
/// Result of running the async iterator rewriter.
/// </summary>
public sealed class AsyncIteratorRewriteResult
{
    public AsyncIteratorRewriteResult(BoundProgram program, ImmutableArray<AsyncIteratorPlan> plans)
    {
        Program = program;
        Plans = plans;
    }

    public BoundProgram Program { get; }

    public ImmutableArray<AsyncIteratorPlan> Plans { get; }
}

/// <summary>
/// Plan for rewriting a single async iterator function into a state machine.
/// </summary>
public sealed class AsyncIteratorPlan
{
    public AsyncIteratorPlan(
        FunctionSymbol function,
        BoundBlockStatement loweredBody,
        TypeSymbol elementType,
        ImmutableDictionary<BoundYieldStatement, int> yieldStates,
        ImmutableDictionary<BoundAwaitExpression, int> awaitStates,
        ImmutableArray<VariableSymbol> hoistedLocals,
        ImmutableArray<(Type PoolKey, TypeSymbol FieldType)> awaiterTypes)
    {
        Function = function;
        LoweredBody = loweredBody;
        ElementType = elementType;
        YieldStates = yieldStates;
        AwaitStates = awaitStates;
        HoistedLocals = hoistedLocals;
        AwaiterTypes = awaiterTypes;
    }

    public FunctionSymbol Function { get; }

    public BoundBlockStatement LoweredBody { get; }

    public TypeSymbol ElementType { get; }

    public ImmutableDictionary<BoundYieldStatement, int> YieldStates { get; }

    public ImmutableDictionary<BoundAwaitExpression, int> AwaitStates { get; }

    public ImmutableArray<VariableSymbol> HoistedLocals { get; }

    public ImmutableArray<(Type PoolKey, TypeSymbol FieldType)> AwaiterTypes { get; }

    /// <summary>
    /// Returns true if the function returns IAsyncEnumerable (vs IAsyncEnumerator).
    /// IAsyncEnumerable gets GetAsyncEnumerator; IAsyncEnumerator does not.
    /// </summary>
    public bool IsEnumerable
    {
        get => AsyncIteratorDetection.IsAsyncEnumerable(Function.Type);
    }
}

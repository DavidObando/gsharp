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
/// Rewrites async iterator functions (those with <c>yield</c> and returning
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

            if (!IsAsyncIteratorFunction(function))
            {
                continue;
            }

            var elementType = GetAsyncIteratorElementType(function.Type);
            if (elementType == null)
            {
                continue;
            }

            // Run async lowering pipeline on the body: exception handler rewrite,
            // spill, ref-hoist. This lifts awaits to statement level.
            var exhRewritten = AsyncExceptionHandlerRewriter.Rewrite(body);
            var spilledBody = SpillSequenceSpiller.Rewrite(exhRewritten);
            var refHoisted = RefInitializationHoister.Rewrite(spilledBody);

            // Collect yields (for state assignment) and awaits.
            var yieldCollector = new YieldStateCollector();
            yieldCollector.Visit(refHoisted);

            var awaitCollector = new AwaitStateCollector();
            awaitCollector.Visit(refHoisted);

            // Collect hoisted locals (all locals — they may live across yield or await).
            var hoistedLocals = CollectHoistedLocals(refHoisted);

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

    private static bool IsAsyncIteratorFunction(FunctionSymbol function)
    {
        // Issue #798: a generic `async sequence[T]` (AsyncSequenceTypeSymbol)
        // with open T projects to a null ClrType. Recognize the symbolic
        // form alongside the IAsyncEnumerable[T] / IAsyncEnumerator[T]
        // shapes so the async iterator rewriter still rewrites it.
        if (function.Type is AsyncSequenceTypeSymbol)
        {
            return true;
        }

        var clr = function.Type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return false;
        }

        var def = clr.GetGenericTypeDefinition();
        var fullName = def?.FullName;
        return fullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerator`1";
    }

    private static bool ContainsYield(BoundStatement statement)
    {
        var walker = new YieldWalker();
        walker.Visit(statement);
        return walker.Found;
    }

    private static TypeSymbol GetAsyncIteratorElementType(TypeSymbol type)
    {
        // Issue #798: `async sequence[T]` (AsyncSequenceTypeSymbol) carries
        // its element symbolically; honor it directly so an open T does not
        // collapse via the ClrType branch.
        if (type is AsyncSequenceTypeSymbol aseq)
        {
            return aseq.ElementType;
        }

        // Issue #1002 (parallel to #990): `IAsyncEnumerable[Shape]` where
        // `Shape` is a same-compilation user class is modelled as an
        // ImportedTypeSymbol carrying `Shape` symbolically in
        // `TypeArguments`. Its `ClrType` is the erased
        // `IAsyncEnumerable<object>` (user types have no ClrType yet, so
        // `MakeGenericType` falls back to `object`). If we go through the
        // ClrType branch below we'd extract `typeof(object)` as the
        // element type and the synthesized state machine would advertise
        // `IAsyncEnumerable<object>` — invalid under generic invariance
        // (ilverify StackUnexpected). Honour the symbolic argument so the
        // SM emits the strongly-typed `IAsyncEnumerable<Shape>` /
        // `IAsyncEnumerator<Shape>`.
        if (type is ImportedTypeSymbol imported
            && imported.OpenDefinition != null
            && !imported.TypeArguments.IsDefaultOrEmpty
            && imported.TypeArguments.Length == 1
            && (imported.OpenDefinition.FullName == "System.Collections.Generic.IAsyncEnumerable`1"
                || imported.OpenDefinition.FullName == "System.Collections.Generic.IAsyncEnumerator`1"))
        {
            return imported.TypeArguments[0];
        }

        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return null;
        }

        var def = clr.GetGenericTypeDefinition();
        if (def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
            def.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
        {
            return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
        }

        return null;
    }

    private static ImmutableArray<VariableSymbol> CollectHoistedLocals(BoundStatement body)
    {
        var collector = new LocalCollector();
        collector.Visit(body);
        return collector.Locals.ToImmutableArray();
    }

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

    private sealed class YieldWalker : BoundTreeWalker
    {
        public bool Found { get; private set; }

        protected override void VisitYieldStatement(BoundYieldStatement node)
        {
            Found = true;
        }
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

    private sealed class LocalCollector : BoundTreeWalker
    {
        public List<VariableSymbol> Locals { get; } = [];

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            // Skip ref-struct (ByRef-like) locals — e.g. the synthesized
            // DefaultInterpolatedStringHandler emitted for interpolated strings
            // (ADR-0055 / issue #368). A ByRef-like type cannot be an instance
            // field, so it must stay a MoveNext local rather than be hoisted.
            if (node.Variable.Type?.ClrType?.IsByRefLike == true)
            {
                base.VisitVariableDeclaration(node);
                return;
            }

            if (!Locals.Contains(node.Variable))
            {
                Locals.Add(node.Variable);
            }

            base.VisitVariableDeclaration(node);
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
        get
        {
            var clr = Function.Type?.ClrType;
            if (clr == null || !clr.IsGenericType)
            {
                return false;
            }

            var def = clr.GetGenericTypeDefinition();
            return def.FullName == "System.Collections.Generic.IAsyncEnumerable`1";
        }
    }
}

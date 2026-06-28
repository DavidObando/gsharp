// <copyright file="IteratorRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1611 // Element parameters should be documented

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Iterators;

/// <summary>
/// Rewrites iterator functions (those containing <c>yield</c> statements) into
/// state-machine classes implementing <c>IEnumerable&lt;T&gt;</c> and
/// <c>IEnumerator&lt;T&gt;</c> (ADR-0040).
/// </summary>
public static class IteratorRewriter
{
    /// <summary>
    /// Scans the bound program for iterator functions and builds rewrite plans.
    /// </summary>
    /// <param name="program">The bound program.</param>
    /// <returns>The rewrite result containing plans for each iterator function.</returns>
    public static IteratorRewriteResult Rewrite(BoundProgram program)
    {
        if (program == null)
        {
            throw new ArgumentNullException(nameof(program));
        }

        var plans = ImmutableArray.CreateBuilder<IteratorStateMachinePlan>();

        foreach (var pair in program.Functions.OrderBy(p => p.Key.Name, StringComparer.Ordinal))
        {
            var function = pair.Key;
            var body = pair.Value;

            if (!ContainsYield(body))
            {
                continue;
            }

            // Skip async iterators — they go through the async iterator rewriter path.
            if (IsAsyncIteratorFunction(function))
            {
                continue;
            }

            var elementType = GetIteratorElementType(function.Type);
            if (elementType == null)
            {
                continue;
            }

            var plan = BuildPlan(function, body, elementType);
            plans.Add(plan);
        }

        return new IteratorRewriteResult(program, plans.ToImmutable());
    }

    private static bool IsAsyncIteratorFunction(FunctionSymbol function)
    {
        // Issue #798: a generic `async sequence[T]` function is an
        // AsyncSequenceTypeSymbol whose ClrType is null for open T (the
        // CLR projection erases the element type). Recognize the symbolic
        // form so the sync IteratorRewriter correctly skips it and the
        // function flows to AsyncIteratorRewriter.
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

    private static TypeSymbol GetIteratorElementType(TypeSymbol type)
    {
        if (type is SequenceTypeSymbol seq)
        {
            return seq.ElementType;
        }

        // Issue #810: prefer the symbolic type argument when the function's
        // return type is a constructed `ImportedTypeSymbol` (e.g.
        // `IEnumerable[T]` with `T` an open method type parameter). The
        // ClrType path below erases T to `object` and loses the
        // generic-parameter identity we need for the state-machine class.
        // Issue #806: compare via FullName so the check survives the
        // BuildTask MetadataLoadContext path (host-process `typeof()` is
        // not reference-equal to types loaded into a separate context).
        if (type is ImportedTypeSymbol imported
            && !imported.TypeArguments.IsDefaultOrEmpty
            && imported.OpenDefinition != null
            && (imported.OpenDefinition.FullName == "System.Collections.Generic.IEnumerable`1"
                || imported.OpenDefinition.FullName == "System.Collections.Generic.IEnumerator`1"))
        {
            return imported.TypeArguments[0];
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return null;
        }

        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var def = clr.GetGenericTypeDefinition();
            if (def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IEnumerator`1")
            {
                return TypeSymbol.FromClrType(clr.GetGenericArguments()[0]);
            }
        }

        if (clr.FullName == "System.Collections.IEnumerable" ||
            clr.FullName == "System.Collections.IEnumerator")
        {
            return TypeSymbol.FromClrType(typeof(object));
        }

        return null;
    }

    private static IteratorStateMachinePlan BuildPlan(
        FunctionSymbol function,
        BoundStatement body,
        TypeSymbol elementType)
    {
        // Collect yields and assign states.
        var yieldCollector = new YieldStateCollector();
        yieldCollector.Visit(body);
        var yieldStates = yieldCollector.States;

        // Collect hoisted locals (locals that are live across yield points).
        var hoistedLocals = CollectHoistedLocals(body);

        return new IteratorStateMachinePlan(function, body, elementType, yieldStates, hoistedLocals);
    }

    private static ImmutableArray<VariableSymbol> CollectHoistedLocals(BoundStatement body)
    {
        // Simple approach: hoist all locals declared in the body.
        // A more precise analysis would only hoist those live across yields.
        var collector = new LocalCollector();
        collector.Visit(body);
        return collector.Locals.ToImmutableArray();
    }

    private sealed class YieldWalker : BoundTreeWalker
    {
        public bool Found { get; private set; }

        protected override void VisitYieldStatement(BoundYieldStatement node)
        {
            Found = true;
        }
    }

    private sealed class YieldStateCollector : BoundTreeWalker
    {
        private readonly ImmutableDictionary<BoundYieldStatement, int>.Builder states =
            ImmutableDictionary.CreateBuilder<BoundYieldStatement, int>();

        private int nextState = 1; // State 0 = initial, -1 = finished, -2 = before first enumeration.

        public ImmutableDictionary<BoundYieldStatement, int> States => states.ToImmutable();

        protected override void VisitYieldStatement(BoundYieldStatement node)
        {
            states.Add(node, nextState++);
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
}

/// <summary>
/// Result of running the iterator rewriter.
/// </summary>
public sealed class IteratorRewriteResult
{
    /// <summary>Initializes a new instance of the <see cref="IteratorRewriteResult"/> class.</summary>
    public IteratorRewriteResult(BoundProgram program, ImmutableArray<IteratorStateMachinePlan> plans)
    {
        Program = program;
        Plans = plans;
    }

    /// <summary>Gets the original program.</summary>
    public BoundProgram Program { get; }

    /// <summary>Gets the iterator state machine plans.</summary>
    public ImmutableArray<IteratorStateMachinePlan> Plans { get; }
}

/// <summary>
/// Holds the plan for rewriting a single iterator function into a state machine.
/// </summary>
public sealed class IteratorStateMachinePlan
{
    /// <summary>Initializes a new instance of the <see cref="IteratorStateMachinePlan"/> class.</summary>
    public IteratorStateMachinePlan(
        FunctionSymbol function,
        BoundStatement body,
        TypeSymbol elementType,
        ImmutableDictionary<BoundYieldStatement, int> yieldStates,
        ImmutableArray<VariableSymbol> hoistedLocals)
    {
        Function = function;
        Body = body;
        ElementType = elementType;
        YieldStates = yieldStates;
        HoistedLocals = hoistedLocals;
    }

    /// <summary>Gets the original iterator function.</summary>
    public FunctionSymbol Function { get; }

    /// <summary>Gets the original function body.</summary>
    public BoundStatement Body { get; }

    /// <summary>Gets the element type produced by this iterator.</summary>
    public TypeSymbol ElementType { get; }

    /// <summary>Gets the yield statement to state mapping.</summary>
    public ImmutableDictionary<BoundYieldStatement, int> YieldStates { get; }

    /// <summary>Gets the locals that must be hoisted to state machine fields.</summary>
    public ImmutableArray<VariableSymbol> HoistedLocals { get; }
}

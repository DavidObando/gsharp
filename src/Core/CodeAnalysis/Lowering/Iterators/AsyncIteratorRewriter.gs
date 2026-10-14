// <copyright file="AsyncIteratorRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Iterators

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Rewrites async iterator functions (explicitly async or containing `yield`, and returning
/// `IAsyncEnumerable<T>` or `IAsyncEnumerator<T>`)
/// into state-machine classes. Combines the yield-lowering of
/// (cref:IteratorRewriter) with the await-lowering of
/// (cref:AsyncStateMachineRewriter).
shared class AsyncIteratorRewriter {
    /// Assigns monotonically decreasing yield states starting from
    /// (cref:StateMachineStates.FirstResumableAsyncIteratorState) (-4, -5, ...).
    class YieldStateCollector : BoundTreeWalker {
        private let allocator ResumableStateAllocator = ResumableStateAllocator()
        private let states ImmutableDictionary[BoundYieldStatement, int32].Builder = ImmutableDictionary.CreateBuilder[
            BoundYieldStatement,
            int32
        ]()
        prop States ImmutableDictionary[BoundYieldStatement, int32] -> states.ToImmutable()

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            states.Add(node, allocator.AllocateYieldState())
        }
    }

    /// Assigns monotonically increasing await states starting from 0.
    class AwaitStateCollector : BoundTreeWalker {
        private let allocator ResumableStateAllocator = ResumableStateAllocator()
        private let states ImmutableDictionary[BoundAwaitExpression, int32].Builder = ImmutableDictionary.CreateBuilder[
            BoundAwaitExpression,
            int32
        ]()
        prop States ImmutableDictionary[BoundAwaitExpression, int32] -> states.ToImmutable()

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            states.Add(node, allocator.AllocateAwaitState())
            base.VisitAwaitExpression(node)
        }
    }

    private class AwaiterTypeCollector : BoundTreeWalker {
        init() {
            AwaiterTypes = List[Type]()
        }

        prop AwaiterTypes List[Type] {
            get;
        }

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            let awaitableClrType Type? = node.Expression?.Type?.ClrType
            if awaitableClrType != nil {
                let shape AwaitableShape? = AwaitableShape.Resolve(awaitableClrType)
                if shape != nil {
                    AwaiterTypes.Add(shape.AwaiterType)
                }
            }
            base.VisitAwaitExpression(node)
        }
    }

    /// Scans the bound program for async iterator functions and builds rewrite plans.
    /// @param program The bound program.
    /// @param references The compilation's reference resolver, used to lower channel operations onto their
    /// suspending forms (ADR-0174 D4); `null` leaves them blocking.
    /// @returns The rewrite result.
    func Rewrite(program BoundProgram?, references ReferenceResolver? = nil) AsyncIteratorRewriteResult {
        if program == nil {
            throw ArgumentNullException("program")
        }
        let plans = ImmutableArray.CreateBuilder[AsyncIteratorPlan]()
        // Issue #4663: the name order ties for same-named functions; break ties stably.
        for pair in program
            .Functions
            .OrderBy((p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key.Name, StringComparer.Ordinal)
            .ThenBy(
            (p KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> p.Key,
            SymbolSourceOrderComparer.Instance
        ) {
            let function = pair.Key
            let body = pair.Value
            if !AsyncIteratorDetection.IsAsyncIteratorFunction(function, body) {
                continue
            }
            let elementType TypeSymbol? = GetAsyncIteratorElementType(function.Type)
            if elementType == nil {
                continue
            }
            // Issue #2662: lower loops first so synthesized await-for locals
            // and awaits participate in state-machine slot/state allocation.
            var loweredBody = Lowerer.Lower(body)
            // ADR-0174 D4: channel operations park the state machine, not a thread.
            loweredBody = ChannelOperationRewriter.Rewrite(loweredBody, references)
            // Run async lowering pipeline on the body: exception handler rewrite,
            // spill, ref-hoist. This lifts awaits to statement level.
            let exhRewritten = AsyncExceptionHandlerRewriter.Rewrite(loweredBody, preserveFinallyAcrossSuspension: true)
            var spilledBody = SpillSequenceSpiller.Rewrite(exhRewritten)
            spilledBody = SpillSequenceSpiller.RewriteIteratorBlocks(spilledBody)
            let refHoisted = RefInitializationHoister.Rewrite(spilledBody)
            // Collect yields (for state assignment) and awaits.
            let yieldCollector = AsyncIteratorRewriter.YieldStateCollector()
            yieldCollector.Visit(refHoisted)
            let awaitCollector = AsyncIteratorRewriter.AwaitStateCollector()
            awaitCollector.Visit(refHoisted)
            // Reuse the ordinary async capture analysis so assignment-only
            // loop variables and nested-lambda captures are both hoisted.
            let hoistedLocals = AsyncCaptureWalker
                .Analyze(refHoisted, function.Parameters)
                .Locals
                .Cast[VariableSymbol]()
                .ToImmutableArray()
            // Collect awaiter types for pooled awaiter fields.
            let awaiterTypes = CollectAwaiterTypes(refHoisted)
            let plan = AsyncIteratorPlan(
                function,
                refHoisted,
                elementType,
                yieldCollector.States,
                awaitCollector.States,
                hoistedLocals,
                awaiterTypes
            )
            plans.Add(plan)
        }
        return AsyncIteratorRewriteResult(program, plans.ToImmutable())
    }

    private func GetAsyncIteratorElementType(type TypeSymbol) TypeSymbol? -> AsyncIteratorDetection.GetElementType(type)

    private func CollectAwaiterTypes(body BoundStatement) ImmutableArray[(PoolKey Type, FieldType TypeSymbol)] {
        let collector = AsyncIteratorRewriter.AwaiterTypeCollector()
        collector.Visit(body)
        let result = ImmutableArray.CreateBuilder[(Type, TypeSymbol)]()
        let seen = HashSet[Type]()
        var hasReferenceAwaiter = false
        for awaiterClrType in collector.AwaiterTypes {
            if awaiterClrType.IsValueType {
                if seen.Add(awaiterClrType) {
                    result.Add(
                        (
                            awaiterClrType,
                            TypeSymbol.FromClrTypeWithoutNullability(awaiterClrType, NullabilityFreeReason.EmitShape)
                        )
                    )
                }
            } else {
                if !hasReferenceAwaiter {
                    hasReferenceAwaiter = true
                    result.Add(
                        (
                            typeof(object),
                            TypeSymbol.FromClrTypeWithoutNullability(typeof(object), NullabilityFreeReason.TypeLiteral)
                        )
                    )
                }
            }
        }
        return result.ToImmutable()
    }
}

/// Result of running the async iterator rewriter.
class AsyncIteratorRewriteResult {
    init(program BoundProgram, plans ImmutableArray[AsyncIteratorPlan]) {
        Program = program
        Plans = plans
    }

    prop Program BoundProgram {
        get;
    }

    prop Plans ImmutableArray[AsyncIteratorPlan] {
        get;
    }
}

/// Plan for rewriting a single async iterator function into a state machine.
class AsyncIteratorPlan {
    init(
        function FunctionSymbol,
        loweredBody BoundBlockStatement,
        elementType TypeSymbol,
        yieldStates ImmutableDictionary[BoundYieldStatement, int32],
        awaitStates ImmutableDictionary[BoundAwaitExpression, int32],
        hoistedLocals ImmutableArray[VariableSymbol],
        awaiterTypes ImmutableArray[(PoolKey Type, FieldType TypeSymbol)]
    ) {
        Function = function
        LoweredBody = loweredBody
        ElementType = elementType
        YieldStates = yieldStates
        AwaitStates = awaitStates
        HoistedLocals = hoistedLocals
        AwaiterTypes = awaiterTypes
    }

    prop Function FunctionSymbol {
        get;
    }

    prop LoweredBody BoundBlockStatement {
        get;
    }

    prop ElementType TypeSymbol {
        get;
    }

    prop YieldStates ImmutableDictionary[BoundYieldStatement, int32] {
        get;
    }

    prop AwaitStates ImmutableDictionary[BoundAwaitExpression, int32] {
        get;
    }

    prop HoistedLocals ImmutableArray[VariableSymbol] {
        get;
    }

    prop AwaiterTypes ImmutableArray[(PoolKey Type, FieldType TypeSymbol)] {
        get;
    }

    /// Returns true if the function returns IAsyncEnumerable (vs IAsyncEnumerator).
    /// IAsyncEnumerable gets GetAsyncEnumerator; IAsyncEnumerator does not.
    prop IsEnumerable bool {
        get -> AsyncIteratorDetection.IsAsyncEnumerable(Function.Type)
    }
}

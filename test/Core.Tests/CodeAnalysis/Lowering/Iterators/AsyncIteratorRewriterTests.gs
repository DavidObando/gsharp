// <copyright file="AsyncIteratorRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Iterators

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading.Tasks
import Xunit

/// Unit tests for (cref:AsyncIteratorRewriter). These tests construct
/// bound programs with yield and await expressions and verify the async iterator
/// rewriter produces correct state-machine plans.
open class AsyncIteratorRewriterTests {
    @Fact
    func Rewrite_YieldOnly_CreatesAsyncIteratorPlan() {
        // Arrange: async iterator function with one yield
        let asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32]))
        let function = FunctionSymbol(
            "asyncGen",
            ImmutableArray[ParameterSymbol].Empty,
            asyncEnumerableType,
            $package: Package
        )
        let yieldStmt = BoundYieldStatement(nil, BoundLiteralExpression(nil, 42))
        let body = Block(yieldStmt)
        let program = MakeProgram(function, body)
        // Act
        let result = AsyncIteratorRewriter.Rewrite(program)
        // Assert
        let plan = Assert.Single(result.Plans)
        Assert.Same(function, plan.Function)
        Assert.Equal(typeof(int32), plan.ElementType.ClrType)
        Assert.Single(plan.YieldStates)
    }

    @Fact
    func Rewrite_YieldStatesAllocateDownwardFromNegativeFour() {
        // Arrange: two yields
        let asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32]))
        let function = FunctionSymbol(
            "multiYield",
            ImmutableArray[ParameterSymbol].Empty,
            asyncEnumerableType,
            $package: Package
        )
        let yield1 = BoundYieldStatement(nil, BoundLiteralExpression(nil, 1))
        let yield2 = BoundYieldStatement(nil, BoundLiteralExpression(nil, 2))
        let body = Block(yield1, yield2)
        let program = MakeProgram(function, body)
        // Act
        let result = AsyncIteratorRewriter.Rewrite(program)
        // Assert: yield states start at -4 and decrease
        let plan = Assert.Single(result.Plans)
        let yieldStates = plan.YieldStates.Values.OrderByDescending((v int32) -> v).ToList()
        Assert.Equal(StateMachineStates.FirstResumableAsyncIteratorState, yieldStates[0])
        Assert.Equal(StateMachineStates.FirstResumableAsyncIteratorState - 1, yieldStates[1])
    }

    @Fact
    func Rewrite_AwaitStatesAllocateUpwardFromZero() {
        // Arrange: async iterator with an await
        let asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32]))
        let function = FunctionSymbol(
            "awaitGen",
            ImmutableArray[ParameterSymbol].Empty,
            asyncEnumerableType,
            $package: Package
        )
        let await1 = BoundAwaitExpression(
            nil,
            BoundLiteralExpression(nil, nil, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void
        )
        let await2 = BoundAwaitExpression(
            nil,
            BoundLiteralExpression(nil, nil, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void
        )
        let body = Block(
            BoundExpressionStatement(nil, await1),
            BoundExpressionStatement(nil, await2),
            BoundYieldStatement(nil, BoundLiteralExpression(nil, 99))
        )
        let program = MakeProgram(function, body)
        // Act
        let result = AsyncIteratorRewriter.Rewrite(program)
        // Assert: await states start at 0 and increase
        let plan = Assert.Single(result.Plans)
        let awaitStates = plan.AwaitStates.Values.OrderBy((v int32) -> v).ToList()
        Assert.Equal(2, awaitStates.Count)
        Assert.Equal(0, awaitStates[0])
        Assert.Equal(1, awaitStates[1])
    }

    @Fact
    func Rewrite_MixedYieldAndAwait_ProducesBothStateKinds() {
        // Arrange: body with yield and await interleaved
        let asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32]))
        let function = FunctionSymbol(
            "mixed",
            ImmutableArray[ParameterSymbol].Empty,
            asyncEnumerableType,
            $package: Package
        )
        let awaitExpr = BoundAwaitExpression(
            nil,
            BoundLiteralExpression(nil, nil, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void
        )
        let yieldStmt = BoundYieldStatement(nil, BoundLiteralExpression(nil, 7))
        let body = Block(BoundExpressionStatement(nil, awaitExpr), yieldStmt)
        let program = MakeProgram(function, body)
        // Act
        let result = AsyncIteratorRewriter.Rewrite(program)
        // Assert
        let plan = Assert.Single(result.Plans)
        Assert.Single(plan.YieldStates)
        Assert.Single(plan.AwaitStates)
        // Yield state negative, await state non-negative
        let yieldState = plan.YieldStates.Values.Single()
        let awaitState = plan.AwaitStates.Values.Single()
        Assert.True(yieldState < -3, "Yield state should be <= -4, was $yieldState")
        Assert.True(awaitState >= 0, "Await state should be >= 0, was $awaitState")
    }

    @Fact
    func Rewrite_CollectsAwaiterTypes() {
        // Arrange: await on Task — should collect TaskAwaiter
        let asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32]))
        let function = FunctionSymbol(
            "awaiterTypes",
            ImmutableArray[ParameterSymbol].Empty,
            asyncEnumerableType,
            $package: Package
        )
        let awaitExpr = BoundAwaitExpression(
            nil,
            BoundLiteralExpression(nil, nil, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void
        )
        let body = Block(
            BoundExpressionStatement(nil, awaitExpr),
            BoundYieldStatement(nil, BoundLiteralExpression(nil, 1))
        )
        let program = MakeProgram(function, body)
        // Act
        let result = AsyncIteratorRewriter.Rewrite(program)
        // Assert: at least one awaiter type collected
        let plan = Assert.Single(result.Plans)
        Assert.True(plan.AwaiterTypes.Length > 0, "Should collect awaiter types for pool fields.")
    }

    @Fact
    func Rewrite_NonAsyncIterator_SkipsFunction() {
        // Arrange: plain async function (not returning IAsyncEnumerable)
        let function = FunctionSymbol(
            "notIterator",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundExpressionStatement(nil, BoundLiteralExpression(nil, 1)))
        let program = MakeProgram(function, body)
        // Act
        let result = AsyncIteratorRewriter.Rewrite(program)
        // Assert
        Assert.Empty(result.Plans)
    }

    @Fact
    func Rewrite_AsyncEnumerableWithoutYield_ProducesNoPlan() {
        let function = FunctionSymbol(
            "eager",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32])),
            $package: Package
        )
        let body = Block(BoundReturnStatement(nil, BoundLiteralExpression(nil, nil, function.Type)))
        let result = AsyncIteratorRewriter.Rewrite(MakeProgram(function, body))
        Assert.Empty(result.Plans)
    }

    @Fact
    func Rewrite_ExplicitAsyncEnumerableWithoutYield_ProducesPlan() {
        let function = FunctionSymbol(
            "empty",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32])),
            $package: Package
        ){IsAsync = true}
        let body = Block(BoundExpressionStatement(nil, BoundLiteralExpression(nil, 1)))
        let result = AsyncIteratorRewriter.Rewrite(MakeProgram(function, body))
        Assert.Single(result.Plans)
    }

    @Fact
    func Rewrite_IsEnumerable_TrueForIAsyncEnumerable() {
        // Arrange
        let asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32]))
        let function = FunctionSymbol(
            "enumerable",
            ImmutableArray[ParameterSymbol].Empty,
            asyncEnumerableType,
            $package: Package
        )
        let body = Block(BoundYieldStatement(nil, BoundLiteralExpression(nil, 1)))
        let program = MakeProgram(function, body)
        // Act
        let result = AsyncIteratorRewriter.Rewrite(program)
        // Assert
        let plan = Assert.Single(result.Plans)
        Assert.True(plan.IsEnumerable, "IAsyncEnumerable function should have IsEnumerable=true")
    }

    shared {
        private let Package PackageSymbol = PackageSymbol("main", declaration: nil)

        private func Block(statements ...BoundStatement) BoundBlockStatement {
            return BoundBlockStatement(nil, statements.ToImmutableArray())
        }

        private func MakeProgram(function FunctionSymbol, body BoundBlockStatement) BoundProgram {
            let functions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
            functions.Add(function, body)
            return BoundProgram(
                Package,
                ImmutableArray.Create(Package),
                ImmutableArray[Diagnostic].Empty,
                functions.ToImmutable(),
                entryPoint: nil,
                statement: Block(),
                structs: ImmutableArray[StructSymbol].Empty,
                interfaces: ImmutableArray[InterfaceSymbol].Empty
            )
        }
    }
}

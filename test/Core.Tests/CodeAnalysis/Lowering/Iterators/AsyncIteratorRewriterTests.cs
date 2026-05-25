// <copyright file="AsyncIteratorRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Iterators;

/// <summary>
/// Unit tests for <see cref="AsyncIteratorRewriter"/>. These tests construct
/// bound programs with yield and await expressions and verify the async iterator
/// rewriter produces correct state-machine plans.
/// </summary>
public class AsyncIteratorRewriterTests
{
    private static readonly PackageSymbol Package = new PackageSymbol("main", declaration: null);

    [Fact]
    public void Rewrite_YieldOnly_CreatesAsyncIteratorPlan()
    {
        // Arrange: async iterator function with one yield
        var asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable<int>));
        var function = new FunctionSymbol("asyncGen", ImmutableArray<ParameterSymbol>.Empty, asyncEnumerableType, package: Package);
        var yieldStmt = new BoundYieldStatement(new BoundLiteralExpression(42));
        var body = Block(yieldStmt);
        var program = MakeProgram(function, body);

        // Act
        var result = AsyncIteratorRewriter.Rewrite(program);

        // Assert
        var plan = Assert.Single(result.Plans);
        Assert.Same(function, plan.Function);
        Assert.Equal(typeof(int), plan.ElementType.ClrType);
        Assert.Single(plan.YieldStates);
    }

    [Fact]
    public void Rewrite_YieldStatesAllocateDownwardFromNegativeFour()
    {
        // Arrange: two yields
        var asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable<int>));
        var function = new FunctionSymbol("multiYield", ImmutableArray<ParameterSymbol>.Empty, asyncEnumerableType, package: Package);
        var yield1 = new BoundYieldStatement(new BoundLiteralExpression(1));
        var yield2 = new BoundYieldStatement(new BoundLiteralExpression(2));
        var body = Block(yield1, yield2);
        var program = MakeProgram(function, body);

        // Act
        var result = AsyncIteratorRewriter.Rewrite(program);

        // Assert: yield states start at -4 and decrease
        var plan = Assert.Single(result.Plans);
        var yieldStates = plan.YieldStates.Values.OrderByDescending(v => v).ToList();
        Assert.Equal(StateMachineStates.FirstResumableAsyncIteratorState, yieldStates[0]);
        Assert.Equal(StateMachineStates.FirstResumableAsyncIteratorState - 1, yieldStates[1]);
    }

    [Fact]
    public void Rewrite_AwaitStatesAllocateUpwardFromZero()
    {
        // Arrange: async iterator with an await
        var asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable<int>));
        var function = new FunctionSymbol("awaitGen", ImmutableArray<ParameterSymbol>.Empty, asyncEnumerableType, package: Package);
        var await1 = new BoundAwaitExpression(
            new BoundLiteralExpression(null, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void);
        var await2 = new BoundAwaitExpression(
            new BoundLiteralExpression(null, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void);
        var body = Block(
            new BoundExpressionStatement(await1),
            new BoundExpressionStatement(await2),
            new BoundYieldStatement(new BoundLiteralExpression(99)));
        var program = MakeProgram(function, body);

        // Act
        var result = AsyncIteratorRewriter.Rewrite(program);

        // Assert: await states start at 0 and increase
        var plan = Assert.Single(result.Plans);
        var awaitStates = plan.AwaitStates.Values.OrderBy(v => v).ToList();
        Assert.Equal(2, awaitStates.Count);
        Assert.Equal(0, awaitStates[0]);
        Assert.Equal(1, awaitStates[1]);
    }

    [Fact]
    public void Rewrite_MixedYieldAndAwait_ProducesBothStateKinds()
    {
        // Arrange: body with yield and await interleaved
        var asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable<int>));
        var function = new FunctionSymbol("mixed", ImmutableArray<ParameterSymbol>.Empty, asyncEnumerableType, package: Package);
        var awaitExpr = new BoundAwaitExpression(
            new BoundLiteralExpression(null, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void);
        var yieldStmt = new BoundYieldStatement(new BoundLiteralExpression(7));
        var body = Block(
            new BoundExpressionStatement(awaitExpr),
            yieldStmt);
        var program = MakeProgram(function, body);

        // Act
        var result = AsyncIteratorRewriter.Rewrite(program);

        // Assert
        var plan = Assert.Single(result.Plans);
        Assert.Single(plan.YieldStates);
        Assert.Single(plan.AwaitStates);

        // Yield state negative, await state non-negative
        var yieldState = plan.YieldStates.Values.Single();
        var awaitState = plan.AwaitStates.Values.Single();
        Assert.True(yieldState < -3, $"Yield state should be <= -4, was {yieldState}");
        Assert.True(awaitState >= 0, $"Await state should be >= 0, was {awaitState}");
    }

    [Fact]
    public void Rewrite_CollectsAwaiterTypes()
    {
        // Arrange: await on Task — should collect TaskAwaiter
        var asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable<int>));
        var function = new FunctionSymbol("awaiterTypes", ImmutableArray<ParameterSymbol>.Empty, asyncEnumerableType, package: Package);
        var awaitExpr = new BoundAwaitExpression(
            new BoundLiteralExpression(null, TypeSymbol.FromClrType(typeof(Task))),
            TypeSymbol.Void);
        var body = Block(
            new BoundExpressionStatement(awaitExpr),
            new BoundYieldStatement(new BoundLiteralExpression(1)));
        var program = MakeProgram(function, body);

        // Act
        var result = AsyncIteratorRewriter.Rewrite(program);

        // Assert: at least one awaiter type collected
        var plan = Assert.Single(result.Plans);
        Assert.True(plan.AwaiterTypes.Length > 0, "Should collect awaiter types for pool fields.");
    }

    [Fact]
    public void Rewrite_NonAsyncIterator_SkipsFunction()
    {
        // Arrange: plain async function (not returning IAsyncEnumerable)
        var function = new FunctionSymbol("notIterator", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void, package: Package) { IsAsync = true };
        var body = Block(new BoundExpressionStatement(new BoundLiteralExpression(1)));
        var program = MakeProgram(function, body);

        // Act
        var result = AsyncIteratorRewriter.Rewrite(program);

        // Assert
        Assert.Empty(result.Plans);
    }

    [Fact]
    public void Rewrite_IsEnumerable_TrueForIAsyncEnumerable()
    {
        // Arrange
        var asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable<int>));
        var function = new FunctionSymbol("enumerable", ImmutableArray<ParameterSymbol>.Empty, asyncEnumerableType, package: Package);
        var body = Block(new BoundYieldStatement(new BoundLiteralExpression(1)));
        var program = MakeProgram(function, body);

        // Act
        var result = AsyncIteratorRewriter.Rewrite(program);

        // Assert
        var plan = Assert.Single(result.Plans);
        Assert.True(plan.IsEnumerable, "IAsyncEnumerable function should have IsEnumerable=true");
    }

    #region Helpers

    private static BoundBlockStatement Block(params BoundStatement[] statements)
    {
        return new BoundBlockStatement(statements.ToImmutableArray());
    }

    private static BoundProgram MakeProgram(FunctionSymbol function, BoundBlockStatement body)
    {
        var functions = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        functions.Add(function, body);

        return new BoundProgram(
            Package,
            ImmutableArray.Create(Package),
            ImmutableArray<Diagnostic>.Empty,
            functions.ToImmutable(),
            entryPoint: null,
            statement: Block(),
            structs: ImmutableArray<StructSymbol>.Empty,
            interfaces: ImmutableArray<InterfaceSymbol>.Empty);
    }

    #endregion
}

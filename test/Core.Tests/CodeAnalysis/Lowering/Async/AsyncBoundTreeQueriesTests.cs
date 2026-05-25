// <copyright file="AsyncBoundTreeQueriesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class AsyncBoundTreeQueriesTests
{
    [Fact]
    public void HasAwait_OnExpressionStatementWithAwait_ReturnsTrue()
    {
        var literal = new BoundLiteralExpression(0);
        var await = new BoundAwaitExpression(literal, TypeSymbol.Int);
        var stmt = new BoundExpressionStatement(await);
        Assert.True(AsyncBoundTreeQueries.HasAwait(stmt));
    }

    [Fact]
    public void HasAwait_OnPlainBlock_ReturnsFalse()
    {
        var stmt = new BoundExpressionStatement(new BoundLiteralExpression(42));
        Assert.False(AsyncBoundTreeQueries.HasAwait(stmt));
    }

    [Fact]
    public void HasAwait_OnNestedBlockWithAwait_ReturnsTrue()
    {
        var inner = new BoundExpressionStatement(new BoundAwaitExpression(new BoundLiteralExpression(1), TypeSymbol.Int));
        var outer = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(inner));
        Assert.True(AsyncBoundTreeQueries.HasAwait(outer));
    }

    [Fact]
    public void HasAwait_OnNullSubtree_ReturnsFalse()
    {
        Assert.False(AsyncBoundTreeQueries.HasAwait((BoundStatement)null));
        Assert.False(AsyncBoundTreeQueries.HasAwait((BoundExpression)null));
    }
}

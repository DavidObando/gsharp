// <copyright file="AsyncBoundTreeQueriesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import Xunit

open class AsyncBoundTreeQueriesTests {
    @Fact
    func HasAwait_OnExpressionStatementWithAwait_ReturnsTrue() {
        let literal = BoundLiteralExpression(nil, 0)
        let await_ = BoundAwaitExpression(nil, literal, TypeSymbol.Int32)
        let stmt = BoundExpressionStatement(nil, await_)
        Assert.True(AsyncBoundTreeQueries.HasAwait(stmt))
    }

    @Fact
    func HasAwait_OnPlainBlock_ReturnsFalse() {
        let stmt = BoundExpressionStatement(nil, BoundLiteralExpression(nil, 42))
        Assert.False(AsyncBoundTreeQueries.HasAwait(stmt))
    }

    @Fact
    func HasAwait_OnNestedBlockWithAwait_ReturnsTrue() {
        let inner = BoundExpressionStatement(
            nil,
            BoundAwaitExpression(nil, BoundLiteralExpression(nil, 1), TypeSymbol.Int32)
        )
        let outer = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](inner))
        Assert.True(AsyncBoundTreeQueries.HasAwait(outer))
    }

    @Fact
    func HasAwait_OnNullSubtree_ReturnsFalse() {
        Assert.False(AsyncBoundTreeQueries.HasAwait(default(BoundStatement)))
        Assert.False(AsyncBoundTreeQueries.HasAwait(default(BoundExpression)))
    }
}

// <copyright file="MoveNextBodyBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

open class MoveNextBodyBuilderTests {
    @Fact
    func Build_NoAwaits_CreatesCoreLabels() {
        let body = Block()
        let plan = MoveNextBodyBuilder.Build(body, ImmutableDictionary[BoundAwaitExpression, int32].Empty)
        Assert.Same(body, plan.LoweredBody)
        Assert.Equal("<>sm_dispatch", plan.DispatchLabel.Name)
        Assert.Equal("<>sm_expr_return", plan.ExpressionReturnLabel.Name)
        Assert.Equal("<>sm_exit", plan.ExitLabel.Name)
        Assert.Empty(plan.AwaitResumePoints)
    }

    @Fact
    func Build_AwaitStates_CreatesResumeLabelsOrderedByState() {
        let firstAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 1), TypeSymbol.Int32)
        let secondAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 2), TypeSymbol.Int32)
        let body = Block(BoundExpressionStatement(nil, secondAwait), BoundExpressionStatement(nil, firstAwait))
        let states = ImmutableDictionary.CreateRange(
            []KeyValuePair[BoundAwaitExpression, int32]{
                KeyValuePair[BoundAwaitExpression, int32](secondAwait, 1),
                KeyValuePair[BoundAwaitExpression, int32](firstAwait, 0)
            }
        )
        let plan = MoveNextBodyBuilder.Build(body, states)
        Assert.Collection(
            plan.AwaitResumePoints,
            (point AwaitResumePoint) -> {
                Assert.Same(firstAwait, point.AwaitExpression)
                Assert.Equal(0, point.State)
                Assert.Equal("<>sm_await_resume_0", point.ResumeLabel.Name)
                Assert.Equal("<>sm_await_resume_after_0", point.ResumeAfterLabel.Name)
            },
            (point AwaitResumePoint) -> {
                Assert.Same(secondAwait, point.AwaitExpression)
                Assert.Equal(1, point.State)
                Assert.Equal("<>sm_await_resume_1", point.ResumeLabel.Name)
                Assert.Equal("<>sm_await_resume_after_1", point.ResumeAfterLabel.Name)
            }
        )
    }

    @Fact
    func Build_NullAwaitStates_TreatsAsEmpty() {
        let body = Block()
        let plan = MoveNextBodyBuilder.Build(body, awaitResumeStates: nil)
        Assert.Empty(plan.AwaitResumePoints)
    }

    @Fact
    func Build_NullBody_Throws() {
        Assert.Throws[ArgumentNullException](
            func () object? {
                return MoveNextBodyBuilder.Build(nil, ImmutableDictionary[BoundAwaitExpression, int32].Empty)
            }
        )
    }

    shared {
        private func Block(statements ...BoundStatement) BoundBlockStatement {
            return BoundBlockStatement(nil, statements.ToImmutableArray())
        }
    }
}

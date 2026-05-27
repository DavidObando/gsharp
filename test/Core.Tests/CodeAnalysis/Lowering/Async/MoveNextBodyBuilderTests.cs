// <copyright file="MoveNextBodyBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class MoveNextBodyBuilderTests
{
    [Fact]
    public void Build_NoAwaits_CreatesCoreLabels()
    {
        var body = Block();

        var plan = MoveNextBodyBuilder.Build(body, ImmutableDictionary<BoundAwaitExpression, int>.Empty);

        Assert.Same(body, plan.LoweredBody);
        Assert.Equal("<>sm_dispatch", plan.DispatchLabel.Name);
        Assert.Equal("<>sm_expr_return", plan.ExpressionReturnLabel.Name);
        Assert.Equal("<>sm_exit", plan.ExitLabel.Name);
        Assert.Empty(plan.AwaitResumePoints);
    }

    [Fact]
    public void Build_AwaitStates_CreatesResumeLabelsOrderedByState()
    {
        var firstAwait = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 1), TypeSymbol.Int);
        var secondAwait = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 2), TypeSymbol.Int);
        var body = Block(
            new BoundExpressionStatement(null, secondAwait),
            new BoundExpressionStatement(null, firstAwait));
        var states = ImmutableDictionary.CreateRange(new[]
        {
            new System.Collections.Generic.KeyValuePair<BoundAwaitExpression, int>(secondAwait, 1),
            new System.Collections.Generic.KeyValuePair<BoundAwaitExpression, int>(firstAwait, 0),
        });

        var plan = MoveNextBodyBuilder.Build(body, states);

        Assert.Collection(
            plan.AwaitResumePoints,
            point =>
            {
                Assert.Same(firstAwait, point.AwaitExpression);
                Assert.Equal(0, point.State);
                Assert.Equal("<>sm_await_resume_0", point.ResumeLabel.Name);
                Assert.Equal("<>sm_await_resume_after_0", point.ResumeAfterLabel.Name);
            },
            point =>
            {
                Assert.Same(secondAwait, point.AwaitExpression);
                Assert.Equal(1, point.State);
                Assert.Equal("<>sm_await_resume_1", point.ResumeLabel.Name);
                Assert.Equal("<>sm_await_resume_after_1", point.ResumeAfterLabel.Name);
            });
    }

    [Fact]
    public void Build_NullAwaitStates_TreatsAsEmpty()
    {
        var body = Block();

        var plan = MoveNextBodyBuilder.Build(body, awaitResumeStates: null);

        Assert.Empty(plan.AwaitResumePoints);
    }

    [Fact]
    public void Build_NullBody_Throws()
    {
        Assert.Throws<System.ArgumentNullException>(() => MoveNextBodyBuilder.Build(null, ImmutableDictionary<BoundAwaitExpression, int>.Empty));
    }

    private static BoundBlockStatement Block(params BoundStatement[] statements)
    {
        return new BoundBlockStatement(null, statements.ToImmutableArray());
    }
}

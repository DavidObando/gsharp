// <copyright file="Issue3076SpillSequenceSpillerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public sealed class Issue3076SpillSequenceSpillerTests
{
    [Fact]
    public void GenericStaticClrAssignmentPreservesContainerWhenAwaitIsSpilled()
    {
        var staticContainerType = TypeSymbol.String;
        var member = typeof(GenericStaticSlot<>).GetProperty(nameof(GenericStaticSlot<int>.Value));
        var assignment = new BoundClrPropertyAssignmentExpression(
            syntax: null,
            // Defensive contract test: current binder producers pair a static
            // container with a null receiver, so source does not reach this
            // rebuild. This sentinel forces it and checks metadata only.
            receiver: new BoundLiteralExpression(null, 0),
            member,
            new BoundAwaitExpression(null, new BoundLiteralExpression(null, 1), TypeSymbol.Int32),
            TypeSymbol.Int32,
            staticContainerType: staticContainerType);
        var body = new BoundBlockStatement(
            syntax: null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, assignment)));

        var rewritten = SpillSequenceSpiller.Rewrite(body);

        var statement = Assert.IsType<BoundExpressionStatement>(rewritten.Statements[^1]);
        var rewrittenAssignment = Assert.IsType<BoundClrPropertyAssignmentExpression>(statement.Expression);
        Assert.Same(staticContainerType, rewrittenAssignment.StaticContainerType);
    }

    private static class GenericStaticSlot<T>
    {
        public static int Value { get; set; }
    }
}

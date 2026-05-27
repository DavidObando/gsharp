// <copyright file="AsyncCaptureWalkerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class AsyncCaptureWalkerTests
{
    [Fact]
    public void Analyze_EmptyBody_NoLocals()
    {
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);
        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Empty(result.Parameters);
        Assert.Empty(result.Locals);
    }

    [Fact]
    public void Analyze_DeclaredLocal_IsHoisted()
    {
        var local = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, local, new BoundLiteralExpression(null, 0))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Same(local, result.Locals[0]);
    }

    [Fact]
    public void Analyze_ReferencedLocal_IsHoisted()
    {
        var local = new LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.Int);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundVariableExpression(null, local))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Same(local, result.Locals[0]);
    }

    [Fact]
    public void Analyze_SameLocalReferencedTwice_AppearsOnce()
    {
        var local = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, local, new BoundLiteralExpression(null, 1)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, local)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, local))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
    }

    [Fact]
    public void Analyze_DeterministicOrder_FirstEncounterWins()
    {
        var first = new LocalVariableSymbol("first", isReadOnly: false, TypeSymbol.Int);
        var second = new LocalVariableSymbol("second", isReadOnly: false, TypeSymbol.Int);
        var third = new LocalVariableSymbol("third", isReadOnly: false, TypeSymbol.Int);

        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, first, new BoundLiteralExpression(null, 1)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, second)),
            new BoundVariableDeclaration(null, third, new BoundLiteralExpression(null, 3)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, first))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Equal(new[] { "first", "second", "third" }, result.Locals.Select(l => l.Name).ToArray());
    }

    [Fact]
    public void Analyze_SpillTemp_IsExcluded()
    {
        var userLocal = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int);
        var spillTemp = new LocalVariableSymbol(GeneratedNames.SpillTempField(0), isReadOnly: false, TypeSymbol.Int);

        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, userLocal, new BoundLiteralExpression(null, 1)),
            new BoundVariableDeclaration(null, spillTemp, new BoundLiteralExpression(null, 2))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Equal("x", result.Locals[0].Name);
    }

    [Fact]
    public void Analyze_Parameters_AlwaysHoistedAsProvided()
    {
        var p1 = new ParameterSymbol("a", TypeSymbol.Int);
        var p2 = new ParameterSymbol("b", TypeSymbol.String);
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray.Create(p1, p2));

        Assert.Equal(2, result.Parameters.Length);
        Assert.Same(p1, result.Parameters[0]);
        Assert.Same(p2, result.Parameters[1]);
    }

    [Fact]
    public void Analyze_ParameterReferencedInBody_NotDuplicatedIntoLocals()
    {
        var p1 = new ParameterSymbol("a", TypeSymbol.Int);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundVariableExpression(null, p1))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray.Create(p1));

        Assert.Single(result.Parameters);
        Assert.Empty(result.Locals);
    }
}

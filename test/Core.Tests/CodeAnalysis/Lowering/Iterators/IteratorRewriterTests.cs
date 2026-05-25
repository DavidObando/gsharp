// <copyright file="IteratorRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Iterators;

/// <summary>
/// Unit tests for <see cref="IteratorRewriter"/>. These tests construct
/// bound programs with yield statements and verify the iterator rewriter
/// produces correct state-machine plans.
/// </summary>
public class IteratorRewriterTests
{
    private static readonly PackageSymbol Package = new PackageSymbol("main", declaration: null);

    [Fact]
    public void Rewrite_SingleYield_CreatesIteratorPlan()
    {
        // Arrange: function with one yield
        var elementType = TypeSymbol.Int;
        var seqType = SequenceTypeSymbol.Get(elementType);
        var function = new FunctionSymbol("gen", ImmutableArray<ParameterSymbol>.Empty, seqType, package: Package);
        var yieldStmt = new BoundYieldStatement(new BoundLiteralExpression(42));
        var body = Block(yieldStmt);
        var program = MakeProgram(function, body);

        // Act
        var result = IteratorRewriter.Rewrite(program);

        // Assert
        var plan = Assert.Single(result.Plans);
        Assert.Same(function, plan.Function);
        Assert.Equal(elementType, plan.ElementType);
        Assert.Single(plan.YieldStates);
        Assert.Equal(1, plan.YieldStates[yieldStmt]);
    }

    [Fact]
    public void Rewrite_MultipleYields_AllocateDistinctStates()
    {
        // Arrange: function with three yields
        var seqType = SequenceTypeSymbol.Get(TypeSymbol.Int);
        var function = new FunctionSymbol("multi", ImmutableArray<ParameterSymbol>.Empty, seqType, package: Package);
        var yield1 = new BoundYieldStatement(new BoundLiteralExpression(1));
        var yield2 = new BoundYieldStatement(new BoundLiteralExpression(2));
        var yield3 = new BoundYieldStatement(new BoundLiteralExpression(3));
        var body = Block(yield1, yield2, yield3);
        var program = MakeProgram(function, body);

        // Act
        var result = IteratorRewriter.Rewrite(program);

        // Assert: states should be 1, 2, 3 (incrementing from 1)
        var plan = Assert.Single(result.Plans);
        Assert.Equal(3, plan.YieldStates.Count);
        Assert.Equal(1, plan.YieldStates[yield1]);
        Assert.Equal(2, plan.YieldStates[yield2]);
        Assert.Equal(3, plan.YieldStates[yield3]);
    }

    [Fact]
    public void Rewrite_NoYield_ProducesNoPlan()
    {
        // Arrange: non-iterator function
        var seqType = SequenceTypeSymbol.Get(TypeSymbol.Int);
        var function = new FunctionSymbol("plain", ImmutableArray<ParameterSymbol>.Empty, seqType, package: Package);
        var body = Block(new BoundExpressionStatement(new BoundLiteralExpression(1)));
        var program = MakeProgram(function, body);

        // Act
        var result = IteratorRewriter.Rewrite(program);

        // Assert
        Assert.Empty(result.Plans);
    }

    [Fact]
    public void Rewrite_HoistsAllLocals()
    {
        // Arrange: function with a local and a yield
        var seqType = SequenceTypeSymbol.Get(TypeSymbol.Int);
        var function = new FunctionSymbol("withLocal", ImmutableArray<ParameterSymbol>.Empty, seqType, package: Package);
        var localVar = new LocalVariableSymbol("temp", false, TypeSymbol.Int);
        var body = Block(
            new BoundVariableDeclaration(localVar, new BoundLiteralExpression(10)),
            new BoundYieldStatement(new BoundVariableExpression(localVar)));
        var program = MakeProgram(function, body);

        // Act
        var result = IteratorRewriter.Rewrite(program);

        // Assert: local should be in hoisted locals
        var plan = Assert.Single(result.Plans);
        Assert.Contains(plan.HoistedLocals, v => v.Name == "temp");
    }

    [Fact]
    public void Rewrite_IEnumerableGenericType_DetectsElementType()
    {
        // Arrange: function returning IEnumerable<string>
        var stringType = TypeSymbol.FromClrType(typeof(string));
        var enumerableType = TypeSymbol.FromClrType(typeof(IEnumerable<string>));
        var function = new FunctionSymbol("strings", ImmutableArray<ParameterSymbol>.Empty, enumerableType, package: Package);
        var body = Block(new BoundYieldStatement(new BoundLiteralExpression("hello")));
        var program = MakeProgram(function, body);

        // Act
        var result = IteratorRewriter.Rewrite(program);

        // Assert
        var plan = Assert.Single(result.Plans);
        Assert.Equal(typeof(string), plan.ElementType.ClrType);
    }

    [Fact]
    public void Rewrite_SkipsAsyncIteratorFunctions()
    {
        // Arrange: async iterator function should be skipped
        var asyncEnumerableType = TypeSymbol.FromClrType(
            typeof(IAsyncEnumerable<int>));
        var function = new FunctionSymbol("asyncGen", ImmutableArray<ParameterSymbol>.Empty, asyncEnumerableType, package: Package);
        var body = Block(new BoundYieldStatement(new BoundLiteralExpression(1)));
        var program = MakeProgram(function, body);

        // Act
        var result = IteratorRewriter.Rewrite(program);

        // Assert: async iterators go through a different path
        Assert.Empty(result.Plans);
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

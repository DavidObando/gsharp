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
        var elementType = TypeSymbol.Int32;
        var seqType = SequenceTypeSymbol.Get(elementType);
        var function = new FunctionSymbol("gen", ImmutableArray<ParameterSymbol>.Empty, seqType, package: Package);
        var yieldStmt = new BoundYieldStatement(null, new BoundLiteralExpression(null, 42));
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
        var seqType = SequenceTypeSymbol.Get(TypeSymbol.Int32);
        var function = new FunctionSymbol("multi", ImmutableArray<ParameterSymbol>.Empty, seqType, package: Package);
        var yield1 = new BoundYieldStatement(null, new BoundLiteralExpression(null, 1));
        var yield2 = new BoundYieldStatement(null, new BoundLiteralExpression(null, 2));
        var yield3 = new BoundYieldStatement(null, new BoundLiteralExpression(null, 3));
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
        var seqType = SequenceTypeSymbol.Get(TypeSymbol.Int32);
        var function = new FunctionSymbol("plain", ImmutableArray<ParameterSymbol>.Empty, seqType, package: Package);
        var body = Block(new BoundExpressionStatement(null, new BoundLiteralExpression(null, 1)));
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
        var seqType = SequenceTypeSymbol.Get(TypeSymbol.Int32);
        var function = new FunctionSymbol("withLocal", ImmutableArray<ParameterSymbol>.Empty, seqType, package: Package);
        var localVar = new LocalVariableSymbol("temp", false, TypeSymbol.Int32);
        var body = Block(
            new BoundVariableDeclaration(null, localVar, new BoundLiteralExpression(null, 10)),
            new BoundYieldStatement(null, new BoundVariableExpression(null, localVar)));
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
        var body = Block(new BoundYieldStatement(null, new BoundLiteralExpression(null, "hello")));
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
        var body = Block(new BoundYieldStatement(null, new BoundLiteralExpression(null, 1)));
        var program = MakeProgram(function, body);

        // Act
        var result = IteratorRewriter.Rewrite(program);

        // Assert: async iterators go through a different path
        Assert.Empty(result.Plans);
    }

    [Fact]
    public void Detection_TraversesBranchesAndTryFinally_ButNotNestedFunctions()
    {
        var yield = new BoundYieldStatement(null, new BoundLiteralExpression(null, 1));
        var branch = new BoundIfStatement(
            null,
            new BoundLiteralExpression(null, true),
            Block(yield),
            Block());
        var tryFinally = new BoundTryStatement(
            null,
            Block(branch),
            ImmutableArray<BoundCatchClause>.Empty,
            Block());

        Assert.True(IteratorDetection.ContainsYield(Block(tryFinally)));

        var sequenceType = SequenceTypeSymbol.Get(TypeSymbol.Int32);
        var nestedFunction = new FunctionSymbol(
            "nested",
            ImmutableArray<ParameterSymbol>.Empty,
            sequenceType,
            package: Package);
        var functionType = FunctionTypeSymbol.Get(ImmutableArray<TypeSymbol>.Empty, sequenceType);
        var literal = new BoundFunctionLiteralExpression(
            null,
            nestedFunction,
            functionType,
            Block(yield),
            ImmutableArray<VariableSymbol>.Empty);
        var lambda = new LocalVariableSymbol("lambda", isReadOnly: true, functionType);

        Assert.False(IteratorDetection.ContainsYield(Block(
            new BoundVariableDeclaration(null, lambda, literal))));
        Assert.False(IteratorDetection.ContainsYield(Block(
            new BoundLocalFunctionDeclaration(null, literal))));
    }

    #region Helpers

    private static BoundBlockStatement Block(params BoundStatement[] statements)
    {
        return new BoundBlockStatement(null, statements.ToImmutableArray());
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

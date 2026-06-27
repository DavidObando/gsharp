// <copyright file="Issue1272ArrayAllocationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1272: parser-level coverage for the native runtime/zero-initialised
/// array allocation form <c>[n]T</c> (and the equivalent empty-initializer
/// spelling <c>[n]T{}</c>), where <c>n</c> is an arbitrary length expression and
/// there are no element initialisers. The existing literal form
/// (<c>[N]T{…}</c>), slice form (<c>[]T{…}</c>), and jagged form
/// (<c>[][]int32{…}</c>) keep parsing unchanged.
/// </summary>
public class Issue1272ArrayAllocationParserTests
{
    private static ArrayCreationExpressionSyntax GetArrayCreation(string initializer)
    {
        var tree = SyntaxTree.Parse($"package P\nlet x = {initializer}\n");
        Assert.Empty(tree.Diagnostics);
        var decl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        return Assert.IsType<ArrayCreationExpressionSyntax>(decl.Initializer);
    }

    [Fact]
    public void RuntimeLength_Identifier_NoInitializer()
    {
        var creation = GetArrayCreation("[n]int32");
        Assert.True(creation.IsRuntimeLengthAllocation);
        Assert.False(creation.HasInitializer);
        Assert.Null(creation.LengthToken);
        var name = Assert.IsType<NameExpressionSyntax>(creation.LengthExpression);
        Assert.Equal("n", name.IdentifierToken.Text);
        Assert.Equal("int32", creation.ElementTypeIdentifier.Text);
    }

    [Fact]
    public void RuntimeLength_Expression_NoInitializer()
    {
        var creation = GetArrayCreation("[n + 1]int32");
        Assert.True(creation.IsRuntimeLengthAllocation);
        Assert.False(creation.HasInitializer);
        Assert.IsType<BinaryExpressionSyntax>(creation.LengthExpression);
    }

    [Fact]
    public void RuntimeLength_EmptyInitializer_IsAllocationForm()
    {
        var creation = GetArrayCreation("[n]int32{}");
        Assert.True(creation.IsRuntimeLengthAllocation);
        Assert.True(creation.HasInitializer);
        Assert.Empty(creation.Elements);
    }

    [Fact]
    public void ConstantLength_NoInitializer_IsAllocationForm()
    {
        var creation = GetArrayCreation("[5]int32");
        Assert.True(creation.IsRuntimeLengthAllocation);
        Assert.False(creation.HasInitializer);
        var literal = Assert.IsType<LiteralExpressionSyntax>(creation.LengthExpression);
        Assert.Equal(SyntaxKind.NumberToken, literal.LiteralToken.Kind);
    }

    [Fact]
    public void LiteralForm_WithInitializer_Unchanged()
    {
        var creation = GetArrayCreation("[5]int32{1, 2, 3, 4, 5}");
        Assert.False(creation.IsRuntimeLengthAllocation);
        Assert.Null(creation.LengthExpression);
        Assert.NotNull(creation.LengthToken);
        Assert.Equal("5", creation.LengthToken.Text);
        Assert.Equal(5, creation.Elements.Count);
    }

    [Fact]
    public void SliceForm_WithInitializer_Unchanged()
    {
        var creation = GetArrayCreation("[]int32{1, 2, 3}");
        Assert.False(creation.IsRuntimeLengthAllocation);
        Assert.Null(creation.LengthExpression);
        Assert.Null(creation.LengthToken);
        Assert.Equal(3, creation.Elements.Count);
    }

    [Fact]
    public void JaggedForm_WithInitializer_Unchanged()
    {
        var creation = GetArrayCreation("[][]int32{ []int32{1}, []int32{2, 3} }");
        Assert.False(creation.IsRuntimeLengthAllocation);
        Assert.True(creation.HasNestedElementTypeClause);
        Assert.Equal(2, creation.Elements.Count);
    }

    [Fact]
    public void RuntimeLength_NestedElement_NoInitializer()
    {
        var creation = GetArrayCreation("[n][]int32");
        Assert.True(creation.IsRuntimeLengthAllocation);
        Assert.True(creation.HasNestedElementTypeClause);
        Assert.False(creation.HasInitializer);
    }
}

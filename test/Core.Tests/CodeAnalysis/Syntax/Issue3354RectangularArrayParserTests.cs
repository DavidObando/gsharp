// <copyright file="Issue3354RectangularArrayParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for native rectangular arrays (issue #3354).</summary>
public class Issue3354RectangularArrayParserTests
{
    [Fact]
    public void TypeClauses_PreserveRankNullableArrayAndGenericCommas()
    {
        var tree = SyntaxTree.Parse(
            "package P\nfunc F(value [,]?int32, cube [,,]string, pair Pair[[,]int32, string]) [,]bool { return [1, 1]bool }\n");

        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Single(function.Parameters[0].Type.ArrayCommaTokens);
        Assert.NotNull(function.Parameters[0].Type.ArrayQuestionToken);
        Assert.Equal(2, function.Parameters[1].Type.ArrayCommaTokens.Length);
        Assert.Equal(2, function.Parameters[2].Type.TypeArguments?.Count);
        Assert.Single(function.Parameters[2].Type.TypeArguments?[0].ArrayCommaTokens);
        Assert.Single(function.Type.ArrayCommaTokens);
    }

    [Fact]
    public void AllocationIndexAndInitializer_PreserveEverySeparatedExpression()
    {
        var tree = SyntaxTree.Parse(
            "package P\nlet a = [rows, cols]int32\nlet b = a[row, col]\nlet c = [2, 2]int32{1, 2, 3, 4}\n");

        Assert.Empty(tree.Diagnostics);
        var declarations = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .ToArray();
        var allocation = Assert.IsType<ArrayCreationExpressionSyntax>(declarations[0].Initializer);
        var index = Assert.IsType<IndexExpressionSyntax>(declarations[1].Initializer);
        var initializer = Assert.IsType<ArrayCreationExpressionSyntax>(declarations[2].Initializer);

        Assert.Equal(2, allocation.Rank);
        Assert.Equal(2, allocation.Dimensions?.Count);
        Assert.Equal(2, index.Indices.Count);
        Assert.Equal(2, initializer.Rank);
        Assert.Equal(4, initializer.Elements?.Count);
        Assert.Equal(
            1,
            allocation.GetChildren().Count(child => ReferenceEquals(child, allocation.Dimensions?[0])));
        Assert.Equal(
            1,
            index.GetChildren().Count(child => ReferenceEquals(child, index.Indices[0])));
    }

    [Fact]
    public void JaggedAndSzArrayForms_RemainDistinctFromRectangularArrays()
    {
        var tree = SyntaxTree.Parse(
            "package P\nlet jagged = [2][]int32\nlet slice = [2]int32\nlet rectangular = [2, 3]int32\n");

        Assert.Empty(tree.Diagnostics);
        var creations = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Select(declaration => Assert.IsType<ArrayCreationExpressionSyntax>(declaration.Initializer))
            .ToArray();

        Assert.True(creations[0].HasNestedElementTypeClause);
        Assert.Equal(1, creations[0].Rank);
        Assert.Equal(1, creations[1].Rank);
        Assert.Equal(2, creations[2].Rank);
    }

    [Fact]
    public void MalformedDimensionAndIndexLists_RecoverAtFollowingDeclarations()
    {
        var tree = SyntaxTree.Parse(
            "package P\nlet bad = [2,, 3]int32\nlet good = [1, 1]int32\nlet item = good[0,, 0]\nlet tail = 42\n");

        Assert.NotEmpty(tree.Diagnostics);
        var declarations = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .ToArray();

        Assert.Equal(4, declarations.Length);
        Assert.Equal("tail", declarations[^1].Identifier.Text);
    }
}

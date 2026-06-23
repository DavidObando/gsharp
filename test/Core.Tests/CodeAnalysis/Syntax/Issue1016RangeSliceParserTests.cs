// <copyright file="Issue1016RangeSliceParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1016: parser-level coverage for the range/slice operator <c>..</c>
/// inside an indexer. <c>a[lo..hi]</c> parses as an
/// <see cref="IndexExpressionSyntax"/> whose index operand is a
/// <see cref="RangeExpressionSyntax"/>, with each bound optional for the open
/// forms (<c>a[..hi]</c>, <c>a[lo..]</c>, <c>a[..]</c>).
/// </summary>
public class Issue1016RangeSliceParserTests
{
    private static RangeExpressionSyntax GetTopLevelRange(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var index = Assert.IsType<IndexExpressionSyntax>(stmt.Initializer);
        return Assert.IsType<RangeExpressionSyntax>(index.Index);
    }

    [Fact]
    public void Parses_ClosedRange_WithBothBounds()
    {
        var range = GetTopLevelRange("""
            package P
            let x = a[1..3]
            """);
        Assert.NotNull(range.LowerBound);
        Assert.NotNull(range.UpperBound);
        Assert.Equal(SyntaxKind.DotDotToken, range.DotDotToken.Kind);
    }

    [Fact]
    public void Parses_OpenLowerBound()
    {
        var range = GetTopLevelRange("""
            package P
            let x = a[..3]
            """);
        Assert.Null(range.LowerBound);
        Assert.NotNull(range.UpperBound);
    }

    [Fact]
    public void Parses_OpenUpperBound()
    {
        var range = GetTopLevelRange("""
            package P
            let x = a[1..]
            """);
        Assert.NotNull(range.LowerBound);
        Assert.Null(range.UpperBound);
    }

    [Fact]
    public void Parses_FullyOpenRange()
    {
        var range = GetTopLevelRange("""
            package P
            let x = a[..]
            """);
        Assert.Null(range.LowerBound);
        Assert.Null(range.UpperBound);
    }

    [Fact]
    public void Parses_ExpressionBounds()
    {
        var range = GetTopLevelRange("""
            package P
            let x = a[i + 1..n - 1]
            """);
        Assert.IsType<BinaryExpressionSyntax>(range.LowerBound);
        Assert.IsType<BinaryExpressionSyntax>(range.UpperBound);
    }

    [Fact]
    public void PlainIndex_IsNotARange()
    {
        var tree = SyntaxTree.Parse("""
            package P
            let x = a[2]
            """);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var index = Assert.IsType<IndexExpressionSyntax>(stmt.Initializer);
        Assert.IsNotType<RangeExpressionSyntax>(index.Index);
    }

    [Fact]
    public void Ellipsis_StillLexesDistinctlyFromDotDot()
    {
        // `...` must remain a single EllipsisToken, not `..` + `.`.
        var tokens = SyntaxTree.ParseTokens("...").ToArray();
        var token = Assert.Single(tokens);
        Assert.Equal(SyntaxKind.EllipsisToken, token.Kind);
    }
}

// <copyright file="Issue1038StandaloneRangeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1038: parser-level coverage for the standalone range expression
/// <c>lo..hi</c> (and the open forms <c>..hi</c>, <c>lo..</c>, <c>..</c>) that
/// produces a <c>System.Range</c> value outside of an index bracket. The <c>..</c>
/// operator binds looser than every binary operator, so <c>1+2..3+4</c> parses as
/// <c>(1+2)..(3+4)</c>; a from-end <c>^n</c> marker is recognised in the upper
/// bound (<c>lo..^hi</c>).
/// </summary>
public class Issue1038StandaloneRangeParserTests
{
    private static RangeExpressionSyntax GetInitializerRange(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        return Assert.IsType<RangeExpressionSyntax>(stmt.Initializer);
    }

    [Fact]
    public void Parses_StandaloneClosedRange()
    {
        var range = GetInitializerRange("""
            package P
            let r = 1..3
            """);
        Assert.NotNull(range.LowerBound);
        Assert.NotNull(range.UpperBound);
        Assert.Equal(SyntaxKind.DotDotToken, range.DotDotToken.Kind);
    }

    [Fact]
    public void Parses_StandaloneOpenLowerBound()
    {
        var range = GetInitializerRange("""
            package P
            let r = ..3
            """);
        Assert.Null(range.LowerBound);
        Assert.NotNull(range.UpperBound);
    }

    [Fact]
    public void Parses_StandaloneOpenUpperBound()
    {
        var range = GetInitializerRange("""
            package P
            let r = 1..
            """);
        Assert.NotNull(range.LowerBound);
        Assert.Null(range.UpperBound);
    }

    [Fact]
    public void Parses_StandaloneFullyOpenRange()
    {
        var range = GetInitializerRange("""
            package P
            let r = ..
            """);
        Assert.Null(range.LowerBound);
        Assert.Null(range.UpperBound);
    }

    [Fact]
    public void RangeBindsLooserThanAdditive()
    {
        // `1+2..3+4` must parse as `(1+2)..(3+4)`: each bound is the whole
        // additive expression, not just the adjacent operand.
        var range = GetInitializerRange("""
            package P
            let r = 1+2..3+4
            """);
        Assert.IsType<BinaryExpressionSyntax>(range.LowerBound);
        Assert.IsType<BinaryExpressionSyntax>(range.UpperBound);
    }

    [Fact]
    public void Parses_FromEndUpperBound()
    {
        var range = GetInitializerRange("""
            package P
            let r = 1..^1
            """);
        Assert.NotNull(range.LowerBound);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.UpperBound);
    }

    [Fact]
    public void Parses_FromEndUpperBound_OpenLower()
    {
        var range = GetInitializerRange("""
            package P
            let r = ..^2
            """);
        Assert.Null(range.LowerBound);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.UpperBound);
    }

    [Fact]
    public void OpenUpperBound_StopsAtNewline()
    {
        // A line break after `..` terminates the open range rather than
        // absorbing the next statement as the upper bound.
        var tree = SyntaxTree.Parse("""
            package P
            let r = 1..
            let s = 5
            """);
        Assert.Empty(tree.Diagnostics);
        var decls = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .ToList();
        Assert.Equal(2, decls.Count);
        var range = Assert.IsType<RangeExpressionSyntax>(decls[0].Initializer);
        Assert.NotNull(range.LowerBound);
        Assert.Null(range.UpperBound);
    }

    [Fact]
    public void IndexRange_StillParsesInsideBrackets()
    {
        // The index-bracket range path (#1016/#1022) is unchanged: `a[^2..]`
        // is a RangeExpression whose lower bound is a from-end marker.
        var tree = SyntaxTree.Parse("""
            package P
            let x = a[^2..]
            """);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var index = Assert.IsType<IndexExpressionSyntax>(stmt.Initializer);
        var range = Assert.IsType<RangeExpressionSyntax>(index.Index);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.LowerBound);
        Assert.Null(range.UpperBound);
    }

    [Fact]
    public void ParenthesizedRange_InsideIndexBracket()
    {
        // `a[(1..3)]` is an ordinary index whose argument is a parenthesised
        // standalone range value (NOT a syntactic index-range).
        var tree = SyntaxTree.Parse("""
            package P
            let x = a[(1..3)]
            """);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var index = Assert.IsType<IndexExpressionSyntax>(stmt.Initializer);
        var paren = Assert.IsType<ParenthesizedExpressionSyntax>(index.Index);
        Assert.IsType<RangeExpressionSyntax>(paren.Expression);
    }
}

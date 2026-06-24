// <copyright file="Issue1022FromEndIndexParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1022: parser-level coverage for the from-end index marker <c>^n</c>.
/// In the leading position of an index/range bound the hat token introduces a
/// <see cref="FromEndIndexExpressionSyntax"/> (<c>a[^1]</c>, <c>a[1..^1]</c>,
/// <c>a[^2..]</c>); everywhere else <c>^</c> keeps its one's-complement /
/// bitwise-XOR meaning.
/// </summary>
public class Issue1022FromEndIndexParserTests
{
    private static ExpressionSyntax GetInitializer(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        return stmt.Initializer;
    }

    [Fact]
    public void SingleFromEndIndex_ParsesAsFromEndMarker()
    {
        var index = Assert.IsType<IndexExpressionSyntax>(GetInitializer("""
            package P
            let x = a[^1]
            """));
        var fromEnd = Assert.IsType<FromEndIndexExpressionSyntax>(index.Index);
        Assert.Equal(SyntaxKind.HatToken, fromEnd.HatToken.Kind);
        Assert.IsType<LiteralExpressionSyntax>(fromEnd.Operand);
    }

    [Fact]
    public void FromEndUpperBound_InClosedRange()
    {
        var index = Assert.IsType<IndexExpressionSyntax>(GetInitializer("""
            package P
            let x = a[1..^1]
            """));
        var range = Assert.IsType<RangeExpressionSyntax>(index.Index);
        Assert.IsType<LiteralExpressionSyntax>(range.LowerBound);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.UpperBound);
    }

    [Fact]
    public void FromEndUpperBound_InOpenLowerRange()
    {
        var index = Assert.IsType<IndexExpressionSyntax>(GetInitializer("""
            package P
            let x = a[..^3]
            """));
        var range = Assert.IsType<RangeExpressionSyntax>(index.Index);
        Assert.Null(range.LowerBound);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.UpperBound);
    }

    [Fact]
    public void FromEndLowerBound_InOpenUpperRange()
    {
        var index = Assert.IsType<IndexExpressionSyntax>(GetInitializer("""
            package P
            let x = a[^2..]
            """));
        var range = Assert.IsType<RangeExpressionSyntax>(index.Index);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.LowerBound);
        Assert.Null(range.UpperBound);
    }

    [Fact]
    public void FromEnd_BothBounds()
    {
        var index = Assert.IsType<IndexExpressionSyntax>(GetInitializer("""
            package P
            let x = a[^3..^1]
            """));
        var range = Assert.IsType<RangeExpressionSyntax>(index.Index);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.LowerBound);
        Assert.IsType<FromEndIndexExpressionSyntax>(range.UpperBound);
    }

    [Fact]
    public void OnesComplement_OutsideBrackets_StillUnary()
    {
        // Prefix `^` outside an index bound remains one's-complement.
        var unary = Assert.IsType<UnaryExpressionSyntax>(GetInitializer("""
            package P
            let x = ^5
            """));
        Assert.Equal(SyntaxKind.HatToken, unary.OperatorToken.Kind);
    }

    [Fact]
    public void Xor_Binary_StillParsesInsideBrackets()
    {
        // A non-leading `^` inside the bracket is the binary XOR operator, not a
        // from-end marker.
        var index = Assert.IsType<IndexExpressionSyntax>(GetInitializer("""
            package P
            let x = a[i ^ j]
            """));
        Assert.IsType<BinaryExpressionSyntax>(index.Index);
    }
}

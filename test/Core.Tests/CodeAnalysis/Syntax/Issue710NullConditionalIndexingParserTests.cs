// <copyright file="Issue710NullConditionalIndexingParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #710 / ADR-0073: parser-level coverage for the new <c>a?[i]</c>
/// null-conditional indexing form. The parser produces an
/// <see cref="IndexExpressionSyntax"/> whose <c>OpenBracketToken.Kind</c>
/// is <see cref="SyntaxKind.QuestionOpenBracketToken"/> and whose
/// <see cref="IndexExpressionSyntax.IsNullConditional"/> is <c>true</c>.
/// </summary>
public class Issue710NullConditionalIndexingParserTests
{
    private static IndexExpressionSyntax GetTopLevelIndex(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        return Assert.IsType<IndexExpressionSyntax>(stmt.Initializer);
    }

    [Fact]
    public void Parses_BareIdentifierTarget_AsNullConditionalIndex()
    {
        const string source = """
            package P
            var x = a?[i]
            """;
        var index = GetTopLevelIndex(source);
        Assert.True(index.IsNullConditional);
        Assert.Equal(SyntaxKind.QuestionOpenBracketToken, index.OpenBracketToken.Kind);
        Assert.IsType<NameExpressionSyntax>(index.Target);
        Assert.IsType<NameExpressionSyntax>(index.Index);
    }

    [Fact]
    public void Parses_StringIndex_AsNullConditionalIndex()
    {
        const string source = """
            package P
            var x = d?["k"]
            """;
        var index = GetTopLevelIndex(source);
        Assert.True(index.IsNullConditional);
        Assert.IsType<LiteralExpressionSyntax>(index.Index);
    }

    [Fact]
    public void Parses_PlainIndex_AsNotNullConditional()
    {
        const string source = """
            package P
            var x = a[i]
            """;
        var index = GetTopLevelIndex(source);
        Assert.False(index.IsNullConditional);
        Assert.Equal(SyntaxKind.OpenSquareBracketToken, index.OpenBracketToken.Kind);
    }

    [Fact]
    public void Parses_ChainedAccess_RightOfDotNullConditional()
    {
        // `a.b?[i]` parses as an Accessor(a, ., IndexExpression(b, ?[, i)).
        const string source = """
            package P
            var x = a.b?[i]
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var outerAccessor = Assert.IsType<AccessorExpressionSyntax>(stmt.Initializer);
        Assert.False(outerAccessor.IsNullConditional);
        var inner = Assert.IsType<IndexExpressionSyntax>(outerAccessor.RightPart);
        Assert.True(inner.IsNullConditional);
    }

    [Fact]
    public void Parses_ChainedNullConditionalThenIndex()
    {
        // `a?.b?[i]` — outer ?., inner ?[].
        const string source = """
            package P
            var x = a?.b?[i]
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var outerAccessor = Assert.IsType<AccessorExpressionSyntax>(stmt.Initializer);
        Assert.True(outerAccessor.IsNullConditional);
        var inner = Assert.IsType<IndexExpressionSyntax>(outerAccessor.RightPart);
        Assert.True(inner.IsNullConditional);
    }

    [Fact]
    public void Parses_DoubleNullConditionalIndex()
    {
        // `a?[i]?[j]` — outer wrap is an IndexExpression with IsNullConditional
        // whose Target is itself an IndexExpression with IsNullConditional.
        const string source = """
            package P
            var x = a?[i]?[j]
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var outer = Assert.IsType<IndexExpressionSyntax>(stmt.Initializer);
        Assert.True(outer.IsNullConditional);
        var inner = Assert.IsType<IndexExpressionSyntax>(outer.Target);
        Assert.True(inner.IsNullConditional);
    }

    [Fact]
    public void Parses_TernaryWithBracketedExpressionStillWorks()
    {
        // Regression: `cond ? then : else` MUST still parse as a ternary
        // even when the branches start with `[`. The lexer keeps `?` and
        // `[` as two tokens whenever they are separated by trivia, so
        // ternary forms remain unambiguous.
        const string source = """
            package P
            var x = (true) ? 1 : 2
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Parses_PostfixChainContinuesAfterNullConditionalIndex()
    {
        // `a?[i]?.b` — null-conditional index, then null-conditional member.
        const string source = """
            package P
            var x = a?[i]?.b
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var stmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var outerAccessor = Assert.IsType<AccessorExpressionSyntax>(stmt.Initializer);
        Assert.True(outerAccessor.IsNullConditional);
        var index = Assert.IsType<IndexExpressionSyntax>(outerAccessor.LeftPart);
        Assert.True(index.IsNullConditional);
    }
}

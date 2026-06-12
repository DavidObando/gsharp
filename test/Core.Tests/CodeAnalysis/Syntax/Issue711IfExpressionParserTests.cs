// <copyright file="Issue711IfExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #711 / ADR-0064 — parser-level tests for `if` used as a
/// value-producing expression. Covers the shapes called out in the issue
/// scope: simple `if … else`, `else if` chains, nested forms, use in
/// let-init, use in argument position, use as the trailing expression of a
/// block, and the negative regressions that protect the if-statement form.
/// </summary>
public class Issue711IfExpressionParserTests
{
    [Fact]
    public void Parses_IfExpression_InLetInitializer()
    {
        const string source = """
            package P
            import System
            let x = if true { 1 } else { 2 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifExpr = FindFirst<IfExpressionSyntax>(tree);
        Assert.NotNull(ifExpr.ElseKeyword);
        Assert.IsType<BlockExpressionSyntax>(ifExpr.ThenBlock);
        Assert.IsType<BlockExpressionSyntax>(ifExpr.ElseExpression);
        Assert.NotNull(((BlockExpressionSyntax)ifExpr.ThenBlock).Expression);
        Assert.NotNull(((BlockExpressionSyntax)ifExpr.ElseExpression).Expression);
    }

    [Fact]
    public void Parses_IfExpression_ElseIfChain_NestsRightAssociatively()
    {
        const string source = """
            package P
            let x = if 1 == 1 { "a" } else if 2 == 2 { "b" } else { "c" }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outerIf = FindFirst<IfExpressionSyntax>(tree);
        Assert.NotNull(outerIf.ElseKeyword);

        var innerIf = Assert.IsType<IfExpressionSyntax>(outerIf.ElseExpression);
        Assert.NotNull(innerIf.ElseKeyword);
        Assert.IsType<BlockExpressionSyntax>(innerIf.ElseExpression);
    }

    [Fact]
    public void Parses_NestedIfExpression_InThenBranch()
    {
        const string source = """
            package P
            let x = if true { if false { 1 } else { 2 } } else { 3 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        // Both an outer and an inner IfExpression should be present.
        var ifs = Walk(tree.Root).OfType<IfExpressionSyntax>().ToList();
        Assert.Equal(2, ifs.Count);
    }

    [Fact]
    public void Parses_IfExpression_AsCallArgument()
    {
        const string source = """
            package P
            import System
            Console.WriteLine(if true { "yes" } else { "no" })
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.NotNull(FindFirst<IfExpressionSyntax>(tree));
    }

    [Fact]
    public void Parses_IfExpression_AsTrailingExpressionOfBlock()
    {
        const string source = """
            package P
            let x = if true {
                if false { 1 } else { 2 }
            } else {
                3
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outerIf = FindFirst<IfExpressionSyntax>(tree);
        var thenBlock = outerIf.ThenBlock;

        // The then-block's trailing expression is the nested if-expression.
        Assert.IsType<IfExpressionSyntax>(thenBlock.Expression);
        Assert.Empty(thenBlock.Statements);
    }

    [Fact]
    public void Parses_MultiStatementBlock_TrailingExpressionLifts()
    {
        const string source = """
            package P
            import System
            let x = if true {
                Console.Write("")
                42
            } else {
                0
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifExpr = FindFirst<IfExpressionSyntax>(tree);
        var block = ifExpr.ThenBlock;
        Assert.Single(block.Statements);
        Assert.NotNull(block.Expression);
    }

    [Fact]
    public void Parses_IfExpression_InReturnStatement()
    {
        const string source = """
            package P
            func Pick(b bool) int32 {
                return if b { 1 } else { -1 }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.NotNull(FindFirst<IfExpressionSyntax>(tree));
    }

    [Fact]
    public void Parses_IfExpression_MissingElse_NoParseError_DeferredToBinder()
    {
        // Parser-side this still parses — diagnostic GS0276 is reported by
        // the binder at value position. The parser shape MUST not eat the
        // surrounding context.
        const string source = """
            package P
            let x = if true { 1 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifExpr = FindFirst<IfExpressionSyntax>(tree);
        Assert.Null(ifExpr.ElseKeyword);
        Assert.Null(ifExpr.ElseExpression);
    }

    [Fact]
    public void Parses_IfStatement_StillWorks_WithoutElse()
    {
        // Regression guard for ADR-0064: existing if-statements with no else
        // continue to parse as if-statements (not if-expressions), and the
        // body of the if is a BlockStatementSyntax — not a BlockExpression.
        const string source = """
            package P
            import System
            func F() {
                if true {
                    Console.Write("x")
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifStmt = FindFirst<IfStatementSyntax>(tree);
        Assert.IsType<BlockStatementSyntax>(ifStmt.ThenStatement);
        Assert.Null(ifStmt.ElseClause);
    }

    [Fact]
    public void Parses_IfStatement_StillWorks_WithElseIfChain()
    {
        // Regression guard: an `if` used as a statement may still chain
        // through `else if` shapes that mirror the expression form.
        const string source = """
            package P
            import System
            func F(n int32) {
                if n > 0 {
                    Console.Write("p")
                } else if n < 0 {
                    Console.Write("n")
                } else {
                    Console.Write("z")
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<IfStatementSyntax>(tree);
        Assert.NotNull(stmt.ElseClause);
    }

    [Fact]
    public void Parses_IfStatement_WithInitClause_Unchanged()
    {
        // Regression guard: the `if init; cond { … }` simple-statement form
        // is preserved by the statement path.
        const string source = """
            package P
            import System
            func F() {
                if x := 1; x > 0 {
                    Console.Write("p")
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<IfStatementSyntax>(tree);
        Assert.NotNull(stmt.Initializer);
        Assert.NotNull(stmt.Semicolon);
    }

    private static T FindFirst<T>(SyntaxTree tree)
        where T : SyntaxNode
    {
        return Walk(tree.Root).OfType<T>().First();
    }

    private static System.Collections.Generic.IEnumerable<SyntaxNode> Walk(SyntaxNode node)
    {
        yield return node;
        foreach (var c in node.GetChildren())
        {
            if (c is SyntaxNode sn)
            {
                foreach (var d in Walk(sn))
                {
                    yield return d;
                }
            }
        }
    }
}

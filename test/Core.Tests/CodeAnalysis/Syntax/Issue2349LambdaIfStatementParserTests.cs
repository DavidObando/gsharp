// <copyright file="Issue2349LambdaIfStatementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #2349 — <c>LooksLikeIfExpression</c> (ADR-0128 / issue #1172) decided
/// whether an <c>if</c>/<c>else if</c> chain inside a block expression (an
/// arrow-lambda body, or an if-expression arm) was a value-producing
/// if-EXPRESSION purely from its SHAPE: does the chain terminate in a plain
/// <c>else { ... }</c>? That answers whether every code path yields A value,
/// but not whether the construct is actually USED as a value. A mid-body
/// if/else (more statements follow it in the same block) can never be used
/// as a value — its result, if any, is always discarded — so it must be a
/// void if-STATEMENT regardless of shape. Requiring value-producing arms
/// for such a mid-body if/else was wrong: the arms are free to end in
/// ordinary void statements (an assignment, a method call, …), and forcing
/// them through the value-requiring block-expression binder produced a
/// spurious GS0124 ("Expression must have a value") even though the if/else
/// was never used as a value.
///
/// The fix adds a POSITION requirement alongside the existing SHAPE
/// requirement: an else-terminated chain is a value-producing if-expression
/// ONLY when it is also the LAST item in its enclosing block expression
/// (i.e. immediately followed by that block's closing <c>}</c>). These
/// parser-level tests pin the resulting <see cref="IfStatementSyntax"/> vs
/// <see cref="IfExpressionSyntax"/> AST shape directly.
/// </summary>
public class Issue2349LambdaIfStatementParserTests
{
    [Fact]
    public void MidBodyIfElse_WithPlainElse_ParsesAsIfStatement_NotIfExpression()
    {
        // The exact bug shape: an else-terminated if/else in the MIDDLE of a
        // lambda block body (more statements follow) must parse as a void
        // IfStatementSyntax, not an IfExpressionSyntax, even though its shape
        // (plain terminal `else { ... }`) would otherwise qualify it as a
        // value-producing if-expression at the block's tail.
        const string source = """
            package P
            import System
            let f = () -> {
                if true {
                    Console.Write("a")
                } else {
                    Console.Write("b")
                }
                Console.Write("c")
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        var block = Assert.IsType<BlockExpressionSyntax>(lambda.Body);

        // Two statements: the if/else (now a plain IfStatementSyntax) and the
        // final `Console.Write("c")`, which becomes the block's trailing
        // value-producing expression (lifted out of Statements).
        Assert.Single(block.Statements);
        Assert.IsType<IfStatementSyntax>(block.Statements[0]);
        Assert.Null(Walk(tree.Root).OfType<IfExpressionSyntax>().FirstOrDefault());
    }

    [Fact]
    public void TailIfElse_WithPlainElse_StillParsesAsIfExpression()
    {
        // Control: when the else-terminated if/else IS the last item in the
        // block (tail position), it is still a value-producing if-expression
        // — unaffected by the fix.
        const string source = """
            package P
            let f = () -> {
                if true { 1 } else { 2 }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        Assert.NotNull(FindFirst<IfExpressionSyntax>(tree));
    }

    [Fact]
    public void MidBodyElseIfChain_WithPlainFinalElse_ParsesAsIfStatement()
    {
        // Same rule for a longer `else if` chain: mid-body use forces the
        // void if-statement form regardless of the chain's shape.
        const string source = """
            package P
            import System
            let f = (n int32) -> {
                if n > 0 {
                    Console.Write("p")
                } else if n < 0 {
                    Console.Write("n")
                } else {
                    Console.Write("z")
                }
                Console.Write("done")
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        var block = Assert.IsType<BlockExpressionSyntax>(lambda.Body);
        Assert.Single(block.Statements);
        Assert.IsType<IfStatementSyntax>(block.Statements[0]);
        Assert.Empty(Walk(tree.Root).OfType<IfExpressionSyntax>());
    }

    [Fact]
    public void TwoMidBodyIfElseBlocks_ThenTrailingReturn_BothParseAsIfStatements()
    {
        // The exact real-world shape (Oahu.Diagnostics `rootCmd.SetAction`
        // async lambda): TWO independent mid-body if/else constructs,
        // followed by further statements and a final return. Neither if/else
        // is in tail position, so both must be void if-statements.
        const string source = """
            package P
            import System
            let f = (doExport bool, useJson bool) -> {
                var report = ""
                if doExport {
                    report = "export"
                } else {
                    report = "run"
                }

                if useJson {
                    Console.WriteLine("json: " + report)
                } else {
                    Console.WriteLine("pretty: " + report)
                }

                return 0
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifStatements = Walk(tree.Root).OfType<IfStatementSyntax>().ToList();
        Assert.Equal(2, ifStatements.Count);
        Assert.Empty(Walk(tree.Root).OfType<IfExpressionSyntax>());
    }

    [Fact]
    public void MidBodyIfElse_NestedInsideAnotherIfsThenBlock_ParsesAsIfStatement()
    {
        // Nested blocks: a mid-body if/else inside the then-block of an
        // OUTER if/else (itself mid-body) must also parse as a void
        // if-statement.
        const string source = """
            package P
            import System
            let f = (a bool, b bool) -> {
                if a {
                    if b {
                        Console.Write("ab")
                    } else {
                        Console.Write("a")
                    }
                    Console.Write("after-inner")
                } else {
                    Console.Write("none")
                }
                Console.Write("done")
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.Empty(Walk(tree.Root).OfType<IfExpressionSyntax>());
    }

    [Fact]
    public void AsyncLambda_MidBodyIfElse_ParsesAsIfStatement()
    {
        // Async lambdas use the same block-expression parse path — the fix
        // must apply identically.
        const string source = """
            package P
            import System
            import System.Threading.Tasks
            let f = async () -> {
                var ok = true
                if ok {
                    Console.Write("y")
                } else {
                    Console.Write("n")
                }
                await Task.CompletedTask
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.Empty(Walk(tree.Root).OfType<IfExpressionSyntax>());
    }

    [Fact]
    public void MidBodyIfWithoutElse_StillParsesAsIfStatement_Unaffected()
    {
        // Regression guard: an if/else-if chain WITHOUT a terminating plain
        // else was already a void if-statement regardless of position
        // (issue #1172) — the position check must not change that.
        const string source = """
            package P
            import System
            let f = () -> {
                if true {
                    Console.Write("a")
                }
                Console.Write("b")
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.Empty(Walk(tree.Root).OfType<IfExpressionSyntax>());
    }

    private static T FindFirst<T>(SyntaxTree tree)
        where T : SyntaxNode
    {
        return Walk(tree.Root).OfType<T>().First();
    }

    private static IEnumerable<SyntaxNode> Walk(SyntaxNode node)
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

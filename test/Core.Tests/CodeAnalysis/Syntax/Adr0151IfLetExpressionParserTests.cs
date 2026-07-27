// <copyright file="Adr0151IfLetExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0151 — parser coverage for <c>if let</c> used as a value-producing
/// expression: single and multiple bindings, the optional top-level
/// <c>&amp;&amp;</c> guard and its parenthesization escape hatch, explicit
/// type clauses, <c>else if</c> / <c>else if let</c> chaining, recovery for
/// missing pieces, and the regressions that protect the ADR-0071 STATEMENT
/// forms.
/// </summary>
public class Adr0151IfLetExpressionParserTests
{
    [Fact]
    public void Parses_IfLetExpression_InLetInitializer()
    {
        const string source = """
            package P
            func F(s string?) string {
                let v = if let x = s { x } else { "none" }
                return v
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var expr = FindFirst<IfLetExpressionSyntax>(tree);
        Assert.Equal(1, expr.Bindings.Count);
        Assert.Equal("x", expr.Bindings[0].Identifier.Text);
        Assert.Null(expr.AmpersandAmpersandToken);
        Assert.Null(expr.Guard);
        Assert.NotNull(expr.ElseKeyword);
        Assert.IsType<BlockExpressionSyntax>(expr.ElseExpression);
        Assert.NotNull(expr.ThenBlock.Expression);
        Assert.NotNull(((BlockExpressionSyntax)expr.ElseExpression).Expression);
    }

    [Fact]
    public void Parses_TopLevelAmpersandAmpersand_AsGuard_NotAsInitializerOperand()
    {
        // The user-selected grammar example: the `&&` after the (single)
        // initializer starts the guard, so the initializer is exactly
        // `GetCopyrights()`.
        const string source = """
            package P
            func F() string? {
                return if let copyright = GetCopyrights() && copyright.Length > 0 {
                    copyright[0]
                } else {
                    default(string?)
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var expr = FindFirst<IfLetExpressionSyntax>(tree);
        Assert.NotNull(expr.AmpersandAmpersandToken);
        Assert.Equal(SyntaxKind.AmpersandAmpersandToken, expr.AmpersandAmpersandToken.Kind);
        Assert.NotNull(expr.Guard);

        // The initializer is the bare call — no `&&` was folded into it.
        var initializer = expr.Bindings[0].Initializer;
        Assert.IsNotType<BinaryExpressionSyntax>(initializer);

        // The guard is the comparison, not a conjunction.
        var guard = Assert.IsType<BinaryExpressionSyntax>(expr.Guard);
        Assert.Equal(SyntaxKind.GreaterToken, guard.OperatorToken.Kind);
    }

    [Fact]
    public void Parses_MultipleBindings_ThenOptionalGuard()
    {
        const string source = """
            package P
            func F(a string?, b string?) string {
                return if let x = a, let y = b && x.Length > 0 { y } else { "none" }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var expr = FindFirst<IfLetExpressionSyntax>(tree);
        Assert.Equal(2, expr.Bindings.Count);
        Assert.Equal("x", expr.Bindings[0].Identifier.Text);
        Assert.Equal("y", expr.Bindings[1].Identifier.Text);
        Assert.NotNull(expr.Guard);
    }

    [Fact]
    public void Parses_ParenthesizedLogicalAnd_AsInitializer_NotAsGuardDelimiter()
    {
        // The escape hatch documented in ADR-0151: a logical-and that really
        // belongs to the initializer is parenthesized, so the `&&` that
        // FOLLOWS it is still the guard delimiter.
        const string source = """
            package P
            func F(a bool, b bool, c bool) bool {
                return if let ok = (a && b) && c { ok } else { false }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var expr = FindFirst<IfLetExpressionSyntax>(tree);
        Assert.NotNull(expr.Guard);
        Assert.Equal("c", Assert.IsType<NameExpressionSyntax>(expr.Guard).IdentifierToken.Text);
        Assert.IsType<ParenthesizedExpressionSyntax>(expr.Bindings[0].Initializer);
    }

    [Fact]
    public void Parses_ExplicitUnderlyingTypeClause()
    {
        const string source = """
            package P
            func F(s string?) string {
                return if let v string = s { v } else { "none" }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var expr = FindFirst<IfLetExpressionSyntax>(tree);
        Assert.NotNull(expr.Bindings[0].TypeClause);
    }

    [Fact]
    public void Parses_ElseIfLetChain_NestsRightAssociatively()
    {
        const string source = """
            package P
            func F(a string?, b string?) string {
                return if let x = a { x } else if let y = b { y } else { "none" }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = FindFirst<IfLetExpressionSyntax>(tree);
        var inner = Assert.IsType<IfLetExpressionSyntax>(outer.ElseExpression);
        Assert.IsType<BlockExpressionSyntax>(inner.ElseExpression);
    }

    [Fact]
    public void Parses_PlainIfExpression_ChainingIntoIfLet()
    {
        const string source = """
            package P
            func F(flag bool, a string?) string {
                return if flag { "flag" } else if let x = a { x } else { "none" }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = FindFirst<IfExpressionSyntax>(tree);
        Assert.IsType<IfLetExpressionSyntax>(outer.ElseExpression);
    }

    [Fact]
    public void Parses_NestedIfLetExpression_AsTrailingValueOfBranchBlock()
    {
        const string source = """
            package P
            func F(flag bool, a string?) string {
                return if flag {
                    if let x = a { x } else { "inner" }
                } else {
                    "outer"
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = FindFirst<IfExpressionSyntax>(tree);
        Assert.IsType<IfLetExpressionSyntax>(outer.ThenBlock.Expression);
    }

    [Fact]
    public void Parses_IfLetExpression_InArgumentPosition()
    {
        const string source = """
            package P
            import System
            func F(a string?) {
                Console.WriteLine(if let x = a { x } else { "none" })
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.NotNull(FindFirst<IfLetExpressionSyntax>(tree));
    }

    [Fact]
    public void MissingInitializer_Recovers_WithDiagnostic()
    {
        const string source = """
            package P
            func F(a string?) string {
                return if let x = { x } else { "none" }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void MissingGuardExpression_Recovers_WithDiagnostic()
    {
        const string source = """
            package P
            func F(a string?) string {
                return if let x = a && { x } else { "none" }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void MissingElse_Parses_WithNullElseForTheBinderToReject()
    {
        // The parser does not manufacture an `else` (that would cascade into a
        // bogus block parse); the binder reports GS0276 for the null else,
        // exactly as it does for the ADR-0064 if-expression.
        const string source = """
            package P
            func F(a string?) string {
                return if let x = a { x }
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var expr = FindFirst<IfLetExpressionSyntax>(tree);
        Assert.Null(expr.ElseKeyword);
        Assert.Null(expr.ElseExpression);
    }

    [Fact]
    public void StatementForm_IfLet_StillParsesAsStatement()
    {
        // Regression guard for ADR-0071: a statement-leading `if let` is still
        // an IfLetStatementSyntax even when it has a plain terminal `else`.
        const string source = """
            package P
            import System
            func F(a string?) {
                if let x = a {
                    Console.WriteLine(x)
                } else {
                    Console.WriteLine("none")
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        Assert.NotNull(FindFirst<IfLetStatementSyntax>(tree));
        Assert.Empty(Walk(tree.Root).OfType<IfLetExpressionSyntax>());
    }

    [Fact]
    public void StatementForm_IfLet_KeepsTopLevelLogicalAndInsideTheInitializer()
    {
        // The statement form has no guard clause, so `a && b` stays a single
        // initializer expression — the ADR-0151 delimiter rule is
        // expression-form only.
        const string source = """
            package P
            import System
            func F(a bool, b bool) {
                if let ok = Wrap(a) && b {
                    Console.WriteLine(ok)
                }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var stmt = FindFirst<IfLetStatementSyntax>(tree);
        var initializer = Assert.IsType<BinaryExpressionSyntax>(stmt.Bindings[0].Initializer);
        Assert.Equal(SyntaxKind.AmpersandAmpersandToken, initializer.OperatorToken.Kind);
    }

    [Fact]
    public void StatementForm_GuardLet_StillParsesAsStatement()
    {
        const string source = """
            package P
            func F(a string?) int32 {
                guard let x = a else {
                    return 0
                }
                return x.Length
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        Assert.NotNull(FindFirst<GuardLetStatementSyntax>(tree));
    }

    [Fact]
    public void LambdaBlockBody_TrailingIfLet_StaysAStatement()
    {
        // Regression guard: an arrow-lambda body block is NOT a
        // value-required block, so an existing void body ending in
        // `if let … { return … } else { return … }` keeps parsing as the
        // ADR-0071 statement.
        const string source = """
            package P
            func F(a string?) int32 {
                let g = (s string?) -> {
                    if let x = s {
                        return x.Length
                    } else {
                        return 0
                    }
                }
                return g(a)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        Assert.NotNull(FindFirst<IfLetStatementSyntax>(tree));
        Assert.Empty(Walk(tree.Root).OfType<IfLetExpressionSyntax>());
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
            foreach (var d in Walk(c))
            {
                yield return d;
            }
        }
    }
}

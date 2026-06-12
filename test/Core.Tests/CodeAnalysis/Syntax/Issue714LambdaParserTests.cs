// <copyright file="Issue714LambdaParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #714 / ADR-0074 — parser-level tests for the new arrow-lambda
/// expression form (<c>(x int32) -&gt; body</c>) and for the switch-arm
/// separator change (preferred <c>:</c>, deprecated <c>-&gt;</c> still
/// accepted with a warning).
/// </summary>
public class Issue714LambdaParserTests
{
    [Fact]
    public void Parses_LambdaExpression_InLetInitializer_SingleExpressionBody()
    {
        const string source = """
            package P
            let f = (x int32) -> x + 1
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.Single(lambda.Parameters);
        Assert.Equal("x", lambda.Parameters[0].Identifier.Text);
        Assert.Equal(SyntaxKind.RightArrowToken, lambda.ArrowToken.Kind);
        Assert.IsType<BinaryExpressionSyntax>(lambda.Body);
    }

    [Fact]
    public void Parses_LambdaExpression_WithBlockBody()
    {
        const string source = """
            package P
            let f = (x int32) -> {
              let y = x * 2
              y + 1
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.Single(lambda.Parameters);
        Assert.IsType<BlockExpressionSyntax>(lambda.Body);
    }

    [Fact]
    public void Parses_LambdaExpression_NoParameters()
    {
        const string source = """
            package P
            let f = () -> 42
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.Empty(lambda.Parameters);
        Assert.IsType<LiteralExpressionSyntax>(lambda.Body);
    }

    [Fact]
    public void Parses_LambdaExpression_MultipleParameters()
    {
        const string source = """
            package P
            let f = (x int32, y int32) -> x + y
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.Equal(2, lambda.Parameters.Count);
        Assert.Equal("x", lambda.Parameters[0].Identifier.Text);
        Assert.Equal("y", lambda.Parameters[1].Identifier.Text);
    }

    [Fact]
    public void Parses_LambdaExpression_InArgumentPosition()
    {
        // Lambdas as call arguments — exercise parser disambiguation
        // inside an argument list.
        const string source = """
            package P
            func apply(f Func[int32, int32]) int32 { return f(3) }
            let v = apply((x int32) -> x + 1)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.Single(lambda.Parameters);
    }

    [Fact]
    public void Parses_LambdaExpression_DoesNotConsumeBareIdentifierArrow()
    {
        // No single-param shorthand (per ADR-0074): bare `x -> e` must NOT be
        // taken as a lambda. It is a parse error / unrelated form. The token
        // sequence `x -> e` at expression position should at minimum not be
        // parsed as a LambdaExpression.
        const string source = """
            package P
            let f = x -> x + 1
            """;
        var tree = SyntaxTree.Parse(source);
        // We don't care which exact diagnostic appears; only that the parser
        // did not silently accept a shorthand-lambda form.
        Assert.False(Walk(tree.Root).OfType<LambdaExpressionSyntax>().Any());
    }

    [Fact]
    public void Parses_ParenthesizedExpression_NotMistakenForLambda()
    {
        // `(1 + 2) * 3` must remain a parenthesised expression, not a lambda.
        const string source = """
            package P
            let v = (1 + 2) * 3
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.False(Walk(tree.Root).OfType<LambdaExpressionSyntax>().Any());
    }

    [Fact]
    public void Parses_SwitchExpressionArm_ColonForm_ProducesNoWarning()
    {
        const string source = """
            package P
            let v = switch 1 {
              case 0: "zero"
              default: "other"
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var arms = Walk(tree.Root).OfType<SwitchExpressionArmSyntax>().ToList();
        Assert.Equal(2, arms.Count);
        Assert.All(arms, a => Assert.Equal(SyntaxKind.ColonToken, a.ArrowToken.Kind));
    }

    [Fact]
    public void Parses_SwitchExpressionArm_ArrowForm_StillAcceptedAndWarns()
    {
        const string source = """
            package P
            let v = switch 1 {
              case 0 -> "zero"
              default -> "other"
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var arms = Walk(tree.Root).OfType<SwitchExpressionArmSyntax>().ToList();
        Assert.Equal(2, arms.Count);
        Assert.All(arms, a => Assert.Equal(SyntaxKind.RightArrowToken, a.ArrowToken.Kind));

        var warnings = tree.Diagnostics.Where(d => d.Id == "GS0302").ToList();
        Assert.Equal(2, warnings.Count);
        Assert.All(warnings, w => Assert.False(w.IsError));
    }

    [Fact]
    public void Parses_SwitchExpressionArm_MixedSeparators_OnlyArrowsWarn()
    {
        const string source = """
            package P
            let v = switch 1 {
              case 0: "zero"
              case 1 -> "one"
              default: "other"
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var arms = Walk(tree.Root).OfType<SwitchExpressionArmSyntax>().ToList();
        Assert.Equal(3, arms.Count);
        Assert.Equal(SyntaxKind.ColonToken, arms[0].ArrowToken.Kind);
        Assert.Equal(SyntaxKind.RightArrowToken, arms[1].ArrowToken.Kind);
        Assert.Equal(SyntaxKind.ColonToken, arms[2].ArrowToken.Kind);

        var warnings = tree.Diagnostics.Where(d => d.Id == "GS0302").ToList();
        Assert.Single(warnings);
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

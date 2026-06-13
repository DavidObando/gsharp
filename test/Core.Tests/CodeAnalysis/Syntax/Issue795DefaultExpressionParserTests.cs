// <copyright file="Issue795DefaultExpressionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0100 / issue #795 — parser tests for <c>default(T)</c> and the
/// bare <c>default</c> literal. Verifies both shapes surface as a
/// <see cref="DefaultExpressionSyntax"/>, that the bare form is
/// recognized in target-typed positions (let/var initializer with
/// explicit type, return, argument, ternary branch), and that the
/// existing <c>default</c> arm of a <c>switch</c>/<c>select</c> case is
/// still parsed as the arm leader rather than an expression.
/// </summary>
public class Issue795DefaultExpressionParserTests
{
    [Fact]
    public void Parses_DefaultOfInt32_InLetInitializer()
    {
        const string source = """
            package P
            let x int32 = default(int32)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var def = FindFirst<DefaultExpressionSyntax>(tree);
        Assert.True(def.HasTypeClause);
        Assert.NotNull(def.OpenParenthesis);
        Assert.NotNull(def.CloseParenthesis);
        Assert.NotNull(def.TypeClause);
    }

    [Fact]
    public void Parses_DefaultOfGenericTypeParameter_InReturnStatement()
    {
        const string source = """
            package P
            func MakeZero[T]() T {
                return default(T)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var def = FindFirst<DefaultExpressionSyntax>(tree);
        Assert.True(def.HasTypeClause);
        Assert.NotNull(def.TypeClause);
    }

    [Fact]
    public void Parses_BareDefault_InLetInitializerWithExplicitType()
    {
        const string source = """
            package P
            let x int32 = default
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var def = FindFirst<DefaultExpressionSyntax>(tree);
        Assert.False(def.HasTypeClause);
        Assert.Null(def.OpenParenthesis);
        Assert.Null(def.CloseParenthesis);
        Assert.Null(def.TypeClause);
    }

    [Fact]
    public void Parses_BareDefault_InReturnStatement()
    {
        const string source = """
            package P
            func MakeZero[T]() T {
                return default
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var def = FindFirst<DefaultExpressionSyntax>(tree);
        Assert.False(def.HasTypeClause);
    }

    [Fact]
    public void Parses_BareDefault_InCallArgument()
    {
        const string source = """
            package P
            import System
            Console.WriteLine(default)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var def = FindFirst<DefaultExpressionSyntax>(tree);
        Assert.False(def.HasTypeClause);
    }

    [Fact]
    public void Parses_BareDefault_InTernaryBranch()
    {
        const string source = """
            package P
            let x = true ? 42 : default
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var def = FindFirst<DefaultExpressionSyntax>(tree);
        Assert.False(def.HasTypeClause);
    }

    [Fact]
    public void Parses_DefaultOfNullable_InVariableDeclaration()
    {
        const string source = """
            package P
            var x = default(int32?)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var def = FindFirst<DefaultExpressionSyntax>(tree);
        Assert.True(def.HasTypeClause);
    }

    [Fact]
    public void Parses_DefaultOfClass_PreservesSyntax()
    {
        const string source = """
            package P
            import System
            var x = default(string)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var def = FindFirst<DefaultExpressionSyntax>(tree);
        Assert.True(def.HasTypeClause);
    }

    [Fact]
    public void SwitchStatement_DefaultArm_StillParses_AsArmLeader()
    {
        // Regression guard: the `default` arm-leader keyword of a switch
        // statement is matched in ParseSwitchCase before falling through
        // to expression parsing. This test ensures the new
        // ParseDefaultExpression dispatch does not steal the arm.
        const string source = """
            package P
            import System
            switch 1 {
            case 1 { Console.WriteLine("one") }
            default { Console.WriteLine("other") }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var sw = FindFirst<SwitchStatementSyntax>(tree);
        Assert.True(sw.Cases.Any(c => c.IsDefault));

        // And there should be NO DefaultExpressionSyntax — the keyword
        // was consumed as the arm leader.
        Assert.Empty(Walk(tree.Root).OfType<DefaultExpressionSyntax>());
    }

    [Fact]
    public void SwitchExpression_DefaultArm_StillParses_AsArmLeader()
    {
        const string source = """
            package P
            let x = switch 1 {
            case 1: "one"
            default: "other"
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var sw = FindFirst<SwitchExpressionSyntax>(tree);
        Assert.True(sw.Arms.Any(a => a.IsDefault));
        Assert.Empty(Walk(tree.Root).OfType<DefaultExpressionSyntax>());
    }

    private static T FindFirst<T>(SyntaxTree tree)
        where T : SyntaxNode
        => Walk(tree.Root).OfType<T>().First();

    private static System.Collections.Generic.IEnumerable<SyntaxNode> Walk(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            if (child is SyntaxNode n)
            {
                foreach (var inner in Walk(n))
                {
                    yield return inner;
                }
            }
        }
    }
}

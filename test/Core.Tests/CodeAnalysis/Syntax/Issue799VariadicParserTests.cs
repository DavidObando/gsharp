// <copyright file="Issue799VariadicParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0101 / issue #799 — parser tests for variadic parameters. The
/// canonical G# spelling is <c>name ...T</c> (Go-style: the <c>...</c>
/// token sits between the parameter identifier and the element type);
/// inside the function body the parameter has type <c>[]T</c>. The
/// parser surfaces this through <see cref="ParameterSyntax.EllipsisToken"/>
/// and the derived <see cref="ParameterSyntax.IsVariadic"/> predicate.
/// The C# <c>params</c> keyword is intentionally rejected with GS0363
/// guiding the user at the canonical spelling.
/// </summary>
public class Issue799VariadicParserTests
{
    [Fact]
    public void Parses_VariadicParameter_OnTopLevelFunction()
    {
        const string source = """
            package P
            func sum(nums ...int32) int32 { return 0 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.True(p.IsVariadic);
        Assert.NotNull(p.EllipsisToken);
        Assert.Equal(SyntaxKind.EllipsisToken, p.EllipsisToken.Kind);
        Assert.Equal("nums", p.Identifier.Text);
    }

    [Fact]
    public void Parses_VariadicAfterFixedParameters()
    {
        const string source = """
            package P
            func f(a int32, b string, xs ...int32) int32 { return 0 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var func = FindFirst<FunctionDeclarationSyntax>(tree);
        var parameters = func.Parameters.ToList();
        Assert.Equal(3, parameters.Count);
        Assert.False(parameters[0].IsVariadic);
        Assert.False(parameters[1].IsVariadic);
        Assert.True(parameters[2].IsVariadic);
        Assert.Equal("xs", parameters[2].Identifier.Text);
    }

    [Fact]
    public void Parses_VariadicWithGenericElementType()
    {
        const string source = """
            package P
            func Of[T](values ...T) []T { return values }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var func = FindFirst<FunctionDeclarationSyntax>(tree);
        Assert.True(func.Parameters.Single().IsVariadic);
    }

    [Fact]
    public void NonVariadicParameter_HasNullEllipsis()
    {
        const string source = """
            package P
            func f(a int32) int32 { return a }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.False(p.IsVariadic);
        Assert.Null(p.EllipsisToken);
    }

    [Fact]
    public void ParamsKeyword_IsRejected_WithGS0363()
    {
        // The issue repro spelled the C# form `params values []T`. The G#
        // parser emits GS0363 pointing the user at the canonical `...T`
        // form and recovers by consuming the keyword.
        const string source = """
            package P
            func bad(params values []int32) int32 { return 0 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0363");
    }

    [Fact]
    public void ParamsAsParameterName_RequiresNoFollowingIdentifier()
    {
        // `params` is contextual: the keyword interpretation only fires
        // when the next token is also an IdentifierToken. A parameter
        // literally named `params` parses cleanly when its type is a
        // non-identifier (e.g. a `[]T` slice or `T?` nullable) — the same
        // disambiguation rule applies to `scoped` / `ref` / `out` / `in`.
        const string source = """
            package P
            func f(params []int32) int32 { return 0 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.Equal("params", p.Identifier.Text);
        Assert.False(p.IsVariadic);
    }

    private static T FindFirst<T>(SyntaxTree tree)
        where T : SyntaxNode
        => Walk(tree.Root).OfType<T>().First();

    private static IEnumerable<SyntaxNode> Walk(SyntaxNode node)
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

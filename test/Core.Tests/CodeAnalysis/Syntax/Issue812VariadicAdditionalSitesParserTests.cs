// <copyright file="Issue812VariadicAdditionalSitesParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0102 / issue #812 — parser tests for the additional declaration
/// sites the v1 ADR-0101 grammar deferred:
/// <list type="bullet">
///   <item>class instance method</item>
///   <item>class static (shared) method</item>
///   <item>interface method (including DIM default body)</item>
///   <item>constructor (init)</item>
///   <item>function-literal and arrow lambda</item>
///   <item>named delegate (<c>type X = delegate func(...) R</c>)</item>
/// </list>
/// The parser already accepted the spelling at every site before #812 —
/// the binder is what rejected it with GS0146. These tests pin the
/// grammar so we notice any regression in the parser-side surface.
/// </summary>
public class Issue812VariadicAdditionalSitesParserTests
{
    [Fact]
    public void Parses_Variadic_OnClassInstanceMethod()
    {
        const string source = """
            package P
            class Joiner {
              func Sum(nums ...int32) int32 { return 0 }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.True(p.IsVariadic);
        Assert.Equal("nums", p.Identifier.Text);
    }

    [Fact]
    public void Parses_Variadic_OnSharedStaticMethod()
    {
        const string source = """
            package P
            class Sequences {
              shared {
                func Of[T](values ...T) []T { return values }
              }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.True(p.IsVariadic);
        Assert.Equal("values", p.Identifier.Text);
    }

    [Fact]
    public void Parses_Variadic_OnInterfaceDefaultBody()
    {
        const string source = """
            package P
            interface IAdder {
              func Add(nums ...int32) int32 { return 0 }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.True(p.IsVariadic);
    }

    [Fact]
    public void Parses_Variadic_OnInterfaceAbstractMethod()
    {
        const string source = """
            package P
            interface IAdder {
              func Add(nums ...int32) int32;
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.True(p.IsVariadic);
    }

    [Fact]
    public void Parses_Variadic_OnConstructor()
    {
        const string source = """
            package P
            class Tags {
              var Values []string
              init(vs ...string) { Values = vs }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        // The first parameter belongs to the init constructor.
        var p = FindFirst<ParameterSyntax>(tree);
        Assert.True(p.IsVariadic);
        Assert.Equal("vs", p.Identifier.Text);
    }

    [Fact]
    public void Parses_Variadic_OnFunctionLiteralLambda()
    {
        const string source = """
            package P
            let f = func(xs ...int32) int32 { return 0 }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.True(p.IsVariadic);
    }

    [Fact]
    public void Parses_Variadic_OnArrowLambda()
    {
        // ADR-0074 / issue #714 lambdas allow a trailing variadic.
        const string source = """
            package P
            let g = (xs ...int32) -> 0
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var p = FindFirst<ParameterSyntax>(tree);
        Assert.True(p.IsVariadic);
    }

    [Fact]
    public void Parses_Variadic_OnNamedDelegateDeclaration()
    {
        const string source = """
            package P
            type StringJoiner = delegate func(sep string, parts ...string) string
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var parameters = Walk(tree.Root).OfType<ParameterSyntax>().ToList();
        Assert.Equal(2, parameters.Count);
        Assert.False(parameters[0].IsVariadic);
        Assert.True(parameters[1].IsVariadic);
        Assert.Equal("parts", parameters[1].Identifier.Text);
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

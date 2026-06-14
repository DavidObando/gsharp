// <copyright file="Issue818AnonymousFunctionTypeVariadicParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #818 — parser-level tests for variadic parameters in anonymous
/// function-type clauses <c>(T1, ...T2) -&gt; R</c>, including the legacy
/// <c>func(T1, ...T2) R</c> spelling and the async arrow form
/// <c>async (T1, ...T2) -&gt; R</c>. ADR-0102 deferred this site in #812;
/// ADR-0102 follow-up #818 closes the gap.
/// </summary>
public class Issue818AnonymousFunctionTypeVariadicParserTests
{
    [Fact]
    public void Parses_Variadic_OnArrowFunctionType_TrailingParameter()
    {
        const string source = """
            package P
            var f (int32, ...string) -> int32 = (a, args) -> a
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.IsArrowFunction);
        Assert.Equal(2, clause.FunctionParameterTypes.Count);
        Assert.False(clause.IsParameterVariadic(0));
        Assert.True(clause.IsParameterVariadic(1));
        Assert.Equal("string", clause.FunctionParameterTypes[1].Identifier.Text);
        Assert.Equal(2, clause.FunctionParameterEllipsisTokens.Length);
        Assert.Null(clause.FunctionParameterEllipsisTokens[0]);
        Assert.NotNull(clause.FunctionParameterEllipsisTokens[1]);
        Assert.Equal(SyntaxKind.EllipsisToken, clause.FunctionParameterEllipsisTokens[1].Kind);
    }

    [Fact]
    public void Parses_Variadic_OnArrowFunctionType_SingleParameter()
    {
        const string source = """
            package P
            var f (...int32) -> int32 = (xs) -> 0
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.Single(clause.FunctionParameterTypes);
        Assert.True(clause.IsParameterVariadic(0));
        Assert.Equal("int32", clause.FunctionParameterTypes[0].Identifier.Text);
    }

    [Fact]
    public void Parses_Variadic_OnAsyncArrowFunctionType()
    {
        const string source = """
            package P
            var f async (int32, ...string) -> int32 = async (a, args) -> a
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsAsyncFunction && t.IsArrowFunction);
        Assert.True(clause.IsAsyncFunction);
        Assert.Equal(2, clause.FunctionParameterTypes.Count);
        Assert.False(clause.IsParameterVariadic(0));
        Assert.True(clause.IsParameterVariadic(1));
    }

    [Fact]
    public void Parses_Variadic_OnLegacyFuncTypeClause()
    {
        const string source = """
            package P
            var f func(int32, ...string) int32 = (a, args) -> a
            """;
        var tree = SyntaxTree.Parse(source);
        // legacy func() emits a GS0303 deprecation warning but it should still parse.
        Assert.DoesNotContain(tree.Diagnostics, d => d.IsError);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsLegacyFuncFunction);
        Assert.True(clause.IsLegacyFuncFunction);
        Assert.Equal(2, clause.FunctionParameterTypes.Count);
        Assert.False(clause.IsParameterVariadic(0));
        Assert.True(clause.IsParameterVariadic(1));
    }

    [Fact]
    public void Parses_Variadic_InFieldTypeClause()
    {
        const string source = """
            package P
            class Box {
              var Handler (int32, ...string) -> int32
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.IsParameterVariadic(1));
    }

    [Fact]
    public void Parses_Variadic_InMethodReturnTypeClause()
    {
        const string source = """
            package P
            func Make() (int32, ...string) -> int32 { return (a, args) -> a }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.IsParameterVariadic(1));
    }

    [Fact]
    public void Parses_Variadic_InNestedFunctionType()
    {
        // Outer is a non-variadic function whose parameter is itself a
        // variadic anonymous function-type.
        const string source = """
            package P
            var f ((int32, ...string) -> int32) -> int32 = (g) -> 0
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var arrows = FindAll<TypeClauseSyntax>(tree).Where(t => t.IsArrowFunction).ToList();
        Assert.True(arrows.Count >= 2);

        // The inner arrow clause is the one with two parameter types.
        var inner = arrows.First(a => a.FunctionParameterTypes.Count == 2);
        Assert.False(inner.IsParameterVariadic(0));
        Assert.True(inner.IsParameterVariadic(1));
    }

    [Fact]
    public void Parses_NonVariadic_HasEmptyEllipsisArray()
    {
        const string source = """
            package P
            var f (int32, string) -> int32 = (a, b) -> a
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.False(clause.IsParameterVariadic(0));
        Assert.False(clause.IsParameterVariadic(1));
    }

    private static IEnumerable<T> FindAll<T>(SyntaxTree tree)
        where T : SyntaxNode
        => Walk(tree.Root).OfType<T>();

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

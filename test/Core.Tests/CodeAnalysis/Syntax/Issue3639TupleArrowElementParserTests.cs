// <copyright file="Issue3639TupleArrowElementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #3639 — a tuple TYPE may contain parenthesized arrow-function
/// elements: <c>((int32) -&gt; int32, (int32) -&gt; int32)</c>. Before the fix
/// the parser saw <c>((</c> + an inner arrow shape and committed to the
/// ADR-0137 parenthesized-arrow form <c>((T) -&gt; R)?</c>, then failed with
/// GS0005 at the tuple's first top-level comma. The parenthesized-arrow
/// look-ahead now also requires that the OUTER paren group has no top-level
/// comma, so tuple types fall through to the tuple parse, whose per-element
/// parses re-dispatch on the arrow look-ahead. cs2gs emits this spelling for
/// C# <c>(Func&lt;int,int&gt;, Func&lt;int,int&gt;)</c> tuples (#3501).
/// </summary>
public class Issue3639TupleArrowElementParserTests
{
    [Fact]
    public void TupleType_WithTwoArrowElements_AsFunctionReturnType()
    {
        const string source = """
            package P
            func mk() ((int32) -> int32, (int32) -> int32) {
                return ((x int32) -> x + 1, (x int32) -> x * 2)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tuple = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.NotNull(tuple.TupleElements);
        Assert.Equal(2, tuple.TupleElements!.Count);
        Assert.All(tuple.TupleElements!, e => Assert.True(e.IsArrowFunction));
        Assert.All(tuple.TupleElements!, e => Assert.Equal("int32", e.ReturnTypeClause.Identifier.Text));
    }

    [Fact]
    public void TupleType_WithZeroArgArrowElements()
    {
        const string source = """
            package P
            func mk() (() -> int32, () -> int32) {
                return (() -> 1, () -> 2)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tuple = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.Equal(2, tuple.TupleElements!.Count);
        Assert.All(tuple.TupleElements!, e => Assert.True(e.IsArrowFunction));
        Assert.All(tuple.TupleElements!, e => Assert.Empty(e.FunctionParameterTypes));
    }

    [Fact]
    public void TupleType_ArrowElementMixedWithNamedType()
    {
        const string source = """
            package P
            var t ((int32) -> int32, string)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tuple = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.Equal(2, tuple.TupleElements!.Count);
        Assert.True(tuple.TupleElements![0].IsArrowFunction);
        Assert.Equal("string", tuple.TupleElements![1].Identifier.Text);
    }

    [Fact]
    public void TupleType_WithArrowElements_InTypeArgumentPosition()
    {
        const string source = """
            package P
            func take() {
                Check.IsType[((int32) -> int32, (int32) -> int32)](nil)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tuple = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.Equal(2, tuple.TupleElements!.Count);
        Assert.All(tuple.TupleElements!, e => Assert.True(e.IsArrowFunction));
    }

    [Fact]
    public void TupleType_WithArrowElement_NestedInGeneric()
    {
        const string source = """
            package P
            var xs List[((int32) -> int32, string)]
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tuple = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.Equal(2, tuple.TupleElements!.Count);
        Assert.True(tuple.TupleElements![0].IsArrowFunction);
        Assert.Equal("string", tuple.TupleElements![1].Identifier.Text);
    }

    [Fact]
    public void TupleType_NamedElements_WithArrowElementTypes()
    {
        // ADR-0172 named elements compose with arrow element types.
        const string source = """
            package P
            func mk() (f (int32) -> int32, g () -> int32) {
                return ((x int32) -> x - 1, () -> 7)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tuple = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.Equal(2, tuple.TupleElements!.Count);
        Assert.Equal("f", tuple.TupleElements![0].TupleElementNameToken?.Text);
        Assert.Equal("g", tuple.TupleElements![1].TupleElementNameToken?.Text);
        Assert.All(tuple.TupleElements!, e => Assert.True(e.IsArrowFunction));
    }

    [Fact]
    public void TupleType_ParenthesizedNullableArrowElement()
    {
        const string source = """
            package P
            var t (((int32) -> int32)?, string)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tuple = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.Equal(2, tuple.TupleElements!.Count);
        Assert.True(tuple.TupleElements![0].IsArrowFunction);
        Assert.True(tuple.TupleElements![0].IsNullable);
    }

    [Fact]
    public void NestedTupleType_WithArrowElement()
    {
        const string source = """
            package P
            var t (((int32) -> int32, string), bool)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var outer = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.Equal(2, outer.TupleElements!.Count);
        var inner = outer.TupleElements![0];
        Assert.True(inner.IsTuple);
        Assert.Equal(2, inner.TupleElements!.Count);
        Assert.True(inner.TupleElements![0].IsArrowFunction);
    }

    [Fact]
    public void ParenthesizedNullableArrowType_StillParsesAsArrow_NotTuple()
    {
        // Negative guard: the ADR-0137 spelling `((T) -> R)?` must keep its
        // meaning — an arrow function type made nullable as a whole.
        const string source = """
            package P
            var f ((int32) -> int32)?
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.False(clause.IsTuple);
        Assert.True(clause.IsNullable);
        Assert.Single(clause.FunctionParameterTypes);
    }

    [Fact]
    public void ParenthesizedNullableArrowType_MultiParameter_StillParsesAsArrow()
    {
        // Negative guard: the comma inside `((int32, string) -> bool)?` is a
        // PARAMETER-list comma (nested paren depth), not a tuple comma.
        const string source = """
            package P
            var f ((int32, string) -> bool)?
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.False(clause.IsTuple);
        Assert.True(clause.IsNullable);
        Assert.Equal(2, clause.FunctionParameterTypes.Count);
    }

    [Fact]
    public void ArrowType_WithTupleReturn_StillParsesAsArrow()
    {
        // Negative guard: `((int32) -> (int32, string))?` — the comma sits in
        // the RETURN tuple (nested paren depth), so the parenthesized-arrow
        // form must still win.
        const string source = """
            package P
            var f ((int32) -> (int32, string))?
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.IsNullable);
        Assert.True(clause.ReturnTypeClause.IsTuple);
    }

    private static IEnumerable<T> FindAll<T>(SyntaxTree tree)
        where T : SyntaxNode
    {
        return Walk(tree.Root).OfType<T>();
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

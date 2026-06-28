// <copyright file="Issue715ArrowFunctionTypeClauseParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #715 / ADR-0075 — parser-level tests for the canonical arrow-form
/// function-type clause <c>(T1, T2, ...) -&gt; R</c> and its async variant
/// <c>async (T) -&gt; R</c>. The legacy <c>func(T) R</c> spelling continues to
/// parse for one release with a GS0303 deprecation warning.
/// </summary>
public class Issue715ArrowFunctionTypeClauseParserTests
{
    [Fact]
    public void Parses_ArrowFunctionType_InVarDeclaration_SingleParameter()
    {
        const string source = """
            package P
            var f (int32) -> int32 = (x int32) -> x + 1
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.IsFunction);
        Assert.True(clause.IsArrowFunction);
        Assert.False(clause.IsLegacyFuncFunction);
        Assert.Null(clause.FuncKeyword);
        Assert.Equal(SyntaxKind.RightArrowToken, clause.ArrowToken.Kind);
        Assert.Single(clause.FunctionParameterTypes);
        Assert.Equal("int32", clause.FunctionParameterTypes[0].Identifier.Text);
        Assert.Equal("int32", clause.ReturnTypeClause.Identifier.Text);
    }

    [Fact]
    public void Parses_ArrowFunctionType_MultipleParameters()
    {
        const string source = """
            package P
            var op (int32, int32) -> int32 = (a int32, b int32) -> a + b
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.Equal(2, clause.FunctionParameterTypes.Count);
        Assert.Equal("int32", clause.FunctionParameterTypes[0].Identifier.Text);
        Assert.Equal("int32", clause.FunctionParameterTypes[1].Identifier.Text);
        Assert.Equal("int32", clause.ReturnTypeClause.Identifier.Text);
    }

    [Fact]
    public void Parses_ArrowFunctionType_ZeroParameters()
    {
        const string source = """
            package P
            var g () -> int32 = () -> 42
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.Empty(clause.FunctionParameterTypes);
        Assert.Equal("int32", clause.ReturnTypeClause.Identifier.Text);
    }

    [Fact]
    public void Parses_ArrowFunctionType_VoidReturn()
    {
        const string source = """
            package P
            var act () -> void = () -> { }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.NotNull(clause.ReturnTypeClause);
        Assert.Equal("void", clause.ReturnTypeClause.Identifier.Text);
    }

    [Fact]
    public void Parses_ArrowFunctionType_TupleReturn()
    {
        const string source = """
            package P
            func split(s string) (string, int32) { return (s, s.Length) }
            var splitter (string) -> (string, int32) = split
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.ReturnTypeClause.IsTuple);
        Assert.Equal(2, clause.ReturnTypeClause.TupleElements.Count);
    }

    [Fact]
    public void Parses_AsyncArrowFunctionType()
    {
        const string source = """
            package P
            async func work(x int32) int32 { return x }
            var cb async (int32) -> int32 = work
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.IsFunction);
        Assert.True(clause.IsArrowFunction);
        Assert.NotNull(clause.AsyncModifier);
        Assert.Equal(SyntaxKind.AsyncKeyword, clause.AsyncModifier.Kind);
        Assert.Single(clause.FunctionParameterTypes);
    }

    [Fact]
    public void Parses_ParenthesizedArrowFunctionType_AsNullableFunctionType()
    {
        const string source = """
            package P
            var cb ((int32) -> void)? = nil
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.IsNullable);
        Assert.Single(clause.FunctionParameterTypes);
        Assert.Equal("void", clause.ReturnTypeClause.Identifier.Text);
    }

    [Fact]
    public void Parses_ParenthesizedAsyncArrowFunctionType_AsNullableFunctionType()
    {
        const string source = """
            package P
            var cb async ((int32) -> int32)? = nil
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.True(clause.IsNullable);
        Assert.NotNull(clause.AsyncModifier);
        Assert.Equal("int32", clause.ReturnTypeClause.Identifier.Text);
    }

    [Fact]
    public void Parses_NullableReturnArrowFunctionType_WithoutNullableFunctionType()
    {
        const string source = """
            package P
            var cb (int32) -> int32? = nil
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsArrowFunction);
        Assert.False(clause.IsNullable);
        Assert.True(clause.ReturnTypeClause.IsNullable);
    }

    [Fact]
    public void Parses_ArrowFunctionType_InParameterPosition()
    {
        const string source = """
            package P
            func apply(f (int32) -> int32, v int32) int32 { return f(v) }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clauses = FindAll<TypeClauseSyntax>(tree).Where(t => t.IsArrowFunction).ToList();
        Assert.Single(clauses);
        Assert.Single(clauses[0].FunctionParameterTypes);
        Assert.Equal("int32", clauses[0].FunctionParameterTypes[0].Identifier.Text);
        Assert.Equal("int32", clauses[0].ReturnTypeClause.Identifier.Text);
    }

    [Fact]
    public void Parses_ArrowFunctionType_InReturnPosition()
    {
        const string source = """
            package P
            func makeAdder(delta int32) (int32) -> int32 { return (x int32) -> x + delta }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clauses = FindAll<TypeClauseSyntax>(tree).Where(t => t.IsArrowFunction).ToList();
        Assert.Single(clauses);
    }

    [Fact]
    public void Parses_ArrowFunctionType_InLetInitializerType()
    {
        const string source = """
            package P
            let f (int32) -> int32 = (x int32) -> x * 2
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clauses = FindAll<TypeClauseSyntax>(tree).Where(t => t.IsArrowFunction).ToList();
        Assert.Single(clauses);
    }

    [Fact]
    public void Parses_ArrowFunctionType_InGenericTypeArgument()
    {
        const string source = """
            package P
            struct Box[T any] { var Value T }
            var b Box[(int32) -> int32]
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clauses = FindAll<TypeClauseSyntax>(tree).Where(t => t.IsArrowFunction).ToList();
        // One arrow-function-typed type argument inside `Box[(int32) -> int32]`.
        Assert.Single(clauses);
    }

    [Fact]
    public void Parses_ArrowFunctionType_InGenericCallTypeArgument()
    {
        // The bounded-lookahead generic-call disambiguation must accept a
        // `(T) -> R` type argument so that `wrap[(int32) -> int32](f)`
        // commits to a generic call rather than collapsing to indexing.
        const string source = """
            package P
            func wrap[T any](v T) T { return v }
            func use() {
                var f (int32) -> int32 = (x int32) -> x
                var g = wrap[(int32) -> int32](f)
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var clauses = FindAll<TypeClauseSyntax>(tree).Where(t => t.IsArrowFunction).ToList();
        // Two arrow-function-typed type clauses: one on `var f` and one in
        // the generic argument list of `wrap[(int32) -> int32]`.
        Assert.Equal(2, clauses.Count);
    }

    [Fact]
    public void TupleType_StillParses_WhenNoArrowFollows()
    {
        const string source = """
            package P
            var p (int32, string) = (1, "x")
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        // The variable's type clause is a tuple, not an arrow function.
        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsTuple);
        Assert.True(clause.IsTuple);
        Assert.False(clause.IsArrowFunction);
        Assert.False(clause.IsFunction);
    }

    [Fact]
    public void LegacyFuncType_StillParses_EmitsGS0303_Warning()
    {
        const string source = """
            package P
            var f func(int32) int32 = (x int32) -> x + 1
            """;
        var tree = SyntaxTree.Parse(source);

        var warnings = tree.Diagnostics.Where(d => d.Id == "GS0303").ToList();
        Assert.Single(warnings);
        Assert.All(warnings, w => Assert.False(w.IsError));

        var clause = FindAll<TypeClauseSyntax>(tree).First(t => t.IsLegacyFuncFunction);
        Assert.True(clause.IsFunction);
        Assert.True(clause.IsLegacyFuncFunction);
        Assert.False(clause.IsArrowFunction);
    }

    [Fact]
    public void LegacyAsyncFuncType_StillParses_EmitsGS0303_Warning()
    {
        const string source = """
            package P
            async func work(x int32) int32 { return x }
            var cb async func(int32) int32 = work
            """;
        var tree = SyntaxTree.Parse(source);

        var warnings = tree.Diagnostics.Where(d => d.Id == "GS0303").ToList();
        Assert.Single(warnings);
    }

    [Fact]
    public void MixedForms_InSameFile_Each_LegacyOccurrence_Warns_Once()
    {
        const string source = """
            package P
            var f func(int32) int32 = (x int32) -> x
            var g (int32) -> int32 = (x int32) -> x
            var h func(int32) int32 = (x int32) -> x
            """;
        var tree = SyntaxTree.Parse(source);

        var warnings = tree.Diagnostics.Where(d => d.Id == "GS0303").ToList();
        Assert.Equal(2, warnings.Count);

        var clauses = FindAll<TypeClauseSyntax>(tree).Where(t => t.IsFunction).ToList();
        Assert.Equal(2, clauses.Count(c => c.IsLegacyFuncFunction));
        Assert.Equal(1, clauses.Count(c => c.IsArrowFunction));
    }

    [Fact]
    public void LegacyAndArrow_BothFunctionTypes_AreSyntacticallyEquivalent_Shape()
    {
        const string legacy = """
            package P
            var f func(int32, int32) int32 = (a int32, b int32) -> a + b
            """;
        const string arrow = """
            package P
            var f (int32, int32) -> int32 = (a int32, b int32) -> a + b
            """;

        var legacyTree = SyntaxTree.Parse(legacy);
        var arrowTree = SyntaxTree.Parse(arrow);

        var legacyClause = FindAll<TypeClauseSyntax>(legacyTree).First(t => t.IsLegacyFuncFunction);
        var arrowClause = FindAll<TypeClauseSyntax>(arrowTree).First(t => t.IsArrowFunction);

        Assert.Equal(legacyClause.FunctionParameterTypes.Count, arrowClause.FunctionParameterTypes.Count);
        Assert.Equal(legacyClause.ReturnTypeClause.Identifier.Text, arrowClause.ReturnTypeClause.Identifier.Text);
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

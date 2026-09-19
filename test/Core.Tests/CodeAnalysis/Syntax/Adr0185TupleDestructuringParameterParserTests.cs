// <copyright file="Adr0185TupleDestructuringParameterParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0185 — parser-level tests for tuple-destructuring arrow-lambda
/// parameters (<c>(x T1, y T2, ...) -&gt; body</c>): the new grammar accepted
/// where it should be, the pre-existing single-tuple-typed-parameter shape
/// (<c>(pair (string, int))</c>) still parsing unchanged, and malformed
/// patterns producing sensible diagnostics.
/// </summary>
public class Adr0185TupleDestructuringParameterParserTests
{
    [Fact]
    public void Parses_DestructuredParameter_TwoElements()
    {
        const string source = """
            package P
            let f = ((x string, y int32)) -> y
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.Single(lambda.Parameters);
        var parameter = lambda.Parameters[0];
        Assert.Null(parameter.Identifier);
        Assert.Null(parameter.Type);
        Assert.True(parameter.IsDestructured);

        var pattern = Assert.IsType<TupleDeconstructionPatternSyntax>(parameter.DeconstructionPattern);
        Assert.Equal(2, pattern.Elements.Count);
        Assert.Equal("x", pattern.Elements[0].Identifier!.Text);
        Assert.Equal("y", pattern.Elements[1].Identifier!.Text);
        Assert.NotNull(pattern.Elements[0].Type);
        Assert.NotNull(pattern.Elements[1].Type);
    }

    [Fact]
    public void Parses_DestructuredParameter_ThreeElements()
    {
        const string source = """
            package P
            let f = ((a int32, b int32, c int32)) -> a + b + c
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        var pattern = Assert.IsType<TupleDeconstructionPatternSyntax>(lambda.Parameters[0].DeconstructionPattern);
        Assert.Equal(3, pattern.Elements.Count);
    }

    [Fact]
    public void Parses_DestructuredParameter_WithDiscardElement()
    {
        const string source = """
            package P
            let f = ((x int32, _ int32)) -> x
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        var pattern = Assert.IsType<TupleDeconstructionPatternSyntax>(lambda.Parameters[0].DeconstructionPattern);
        Assert.Equal("_", pattern.Elements[1].Identifier!.Text);
    }

    [Fact]
    public void Parses_DestructuredParameter_AsSecondOfTwoParameters()
    {
        const string source = """
            package P
            let f = (z int32, (x int32, y int32)) -> z + x + y
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.Equal(2, lambda.Parameters.Count);
        Assert.False(lambda.Parameters[0].IsDestructured);
        Assert.Equal("z", lambda.Parameters[0].Identifier!.Text);
        Assert.True(lambda.Parameters[1].IsDestructured);
    }

    [Fact]
    public void Parses_SingleTupleTypedParameter_NotMistakenForDestructuring()
    {
        // Regression (ADR-0185 open question 2 / Decision point 2): a
        // parenthesized SINGLE parameter whose type happens to be a
        // parenthesized tuple type must keep meaning exactly that — one
        // parameter named `pair`, of tuple type — not a destructuring
        // pattern. Disambiguated trivially: this shape's first interior
        // token is the identifier `pair`, never `(`.
        const string source = """
            package P
            let f = (pair (string, int32)) -> pair
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.Single(lambda.Parameters);
        var parameter = lambda.Parameters[0];
        Assert.False(parameter.IsDestructured);
        Assert.Null(parameter.DeconstructionPattern);
        Assert.Equal("pair", parameter.Identifier!.Text);
        Assert.NotNull(parameter.Type);
    }

    [Fact]
    public void Parses_DestructuredParameter_AsyncLambda()
    {
        const string source = """
            package P
            let f = async ((x int32, y int32)) -> x + y
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.True(lambda.IsAsync);
        Assert.True(lambda.Parameters[0].IsDestructured);
    }

    [Fact]
    public void Parses_DestructuredParameter_SingleElement_NoParseDiagnostic()
    {
        // Syntactically well-formed (arity is a BIND-time concern, ADR-0185
        // open question 2's judgment call — G# has no 1-tuples, mirroring
        // ParseTupleTypeClause's existing `(T)` grouping precedent for the
        // tuple TYPE grammar, but that is not a parse error).
        const string source = """
            package P
            let f = ((x int32)) -> x
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        var pattern = Assert.IsType<TupleDeconstructionPatternSyntax>(lambda.Parameters[0].DeconstructionPattern);
        Assert.Single(pattern.Elements);
    }

    [Fact]
    public void MalformedDestructuringPattern_MissingElementType_ProducesDiagnostic()
    {
        // A C#-habit untyped destructuring `((x, y)) -> ...` still commits
        // to the lambda/destructuring-pattern path (not a confusing
        // tuple-expression error) and reports a real "expected a type"
        // diagnostic for the missing element type.
        const string source = """
            package P
            let f = ((x, y)) -> x
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.True(lambda.Parameters[0].IsDestructured);
    }

    [Fact]
    public void MalformedDestructuringPattern_SecondElementMissingType_ProducesDiagnostic()
    {
        const string source = """
            package P
            let f = ((x int32, y)) -> x
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.True(lambda.Parameters[0].IsDestructured);
    }

    [Fact]
    public void Parses_DestructuredParameter_InArgumentPosition()
    {
        // Parser-only concern (undeclared `apply` produces only a BIND-time
        // diagnostic, which SyntaxTree.Parse's diagnostics never include) —
        // exercises the disambiguator inside an argument list, mirroring
        // Issue714LambdaParserTests.Parses_LambdaExpression_InArgumentPosition.
        const string source = """
            package P
            let v = apply(((x int32, y int32)) -> x + y)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lambda = FindFirst<LambdaExpressionSyntax>(tree);
        Assert.True(lambda.Parameters[0].IsDestructured);
    }

    [Fact]
    public void Parses_ParenthesizedTupleExpression_NotMistakenForDestructuringLambda()
    {
        // A genuine parenthesized tuple EXPRESSION, unrelated to any lambda,
        // must remain unaffected by the new `(` opener check.
        const string source = """
            package P
            let v = (1, 2)
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.False(Walk(tree.Root).OfType<LambdaExpressionSyntax>().Any());
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

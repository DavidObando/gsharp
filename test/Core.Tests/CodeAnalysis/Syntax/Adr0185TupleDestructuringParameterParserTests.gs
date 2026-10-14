// <copyright file="Adr0185TupleDestructuringParameterParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0185 — parser-level tests for tuple-destructuring arrow-lambda
/// parameters (`(x T1, y T2, ...) -> body`): the new grammar accepted
/// where it should be, the pre-existing single-tuple-typed-parameter shape
/// (`(pair (string, int))`) still parsing unchanged, and malformed
/// patterns producing sensible diagnostics.
open class Adr0185TupleDestructuringParameterParserTests {
    @Fact
    func Parses_DestructuredParameter_TwoElements() {
        const source = "package P\nlet f = ((x string, y int32)) -> y"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Single(lambda.Parameters)
        let parameter = lambda.Parameters[0]
        Assert.Null(parameter.Identifier)
        Assert.Null(parameter.Type)
        Assert.True(parameter.IsDestructured)
        let pattern = Assert.IsType[TupleDeconstructionPatternSyntax](parameter.DeconstructionPattern)
        Assert.Equal(2, pattern.Elements.Count)
        Assert.Equal("x", pattern.Elements[0].Identifier!!.Text)
        Assert.Equal("y", pattern.Elements[1].Identifier!!.Text)
        Assert.NotNull(pattern.Elements[0].Type)
        Assert.NotNull(pattern.Elements[1].Type)
    }

    @Fact
    func Parses_DestructuredParameter_ThreeElements() {
        const source = "package P\nlet f = ((a int32, b int32, c int32)) -> a + b + c"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        let pattern = Assert.IsType[TupleDeconstructionPatternSyntax](lambda.Parameters[0].DeconstructionPattern)
        Assert.Equal(3, pattern.Elements.Count)
    }

    @Fact
    func Parses_DestructuredParameter_WithDiscardElement() {
        const source = "package P\nlet f = ((x int32, _ int32)) -> x"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        let pattern = Assert.IsType[TupleDeconstructionPatternSyntax](lambda.Parameters[0].DeconstructionPattern)
        Assert.Equal("_", pattern.Elements[1].Identifier!!.Text)
    }

    @Fact
    func Parses_DestructuredParameter_AsSecondOfTwoParameters() {
        const source = "package P\nlet f = (z int32, (x int32, y int32)) -> z + x + y"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Equal(2, lambda.Parameters.Count)
        Assert.False(lambda.Parameters[0].IsDestructured)
        Assert.Equal("z", lambda.Parameters[0].Identifier!!.Text)
        Assert.True(lambda.Parameters[1].IsDestructured)
    }

    @Fact
    func Parses_SingleTupleTypedParameter_NotMistakenForDestructuring() {
        // Regression (ADR-0185 open question 2 / Decision point 2): a
        // parenthesized SINGLE parameter whose type happens to be a
        // parenthesized tuple type must keep meaning exactly that — one
        // parameter named `pair`, of tuple type — not a destructuring
        // pattern. Disambiguated trivially: this shape's first interior
        // token is the identifier `pair`, never `(`.
        const source = "package P\nlet f = (pair (string, int32)) -> pair"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.Single(lambda.Parameters)
        let parameter = lambda.Parameters[0]
        Assert.False(parameter.IsDestructured)
        Assert.Null(parameter.DeconstructionPattern)
        Assert.Equal("pair", parameter.Identifier!!.Text)
        Assert.NotNull(parameter.Type)
    }

    @Fact
    func Parses_DestructuredParameter_AsyncLambda() {
        const source = "package P\nlet f = async ((x int32, y int32)) -> x + y"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.True(lambda.IsAsync)
        Assert.True(lambda.Parameters[0].IsDestructured)
    }

    @Fact
    func Parses_DestructuredParameter_SingleElement_NoParseDiagnostic() {
        // Syntactically well-formed (arity is a BIND-time concern, ADR-0185
        // open question 2's judgment call — G# has no 1-tuples, mirroring
        // ParseTupleTypeClause's existing `(T)` grouping precedent for the
        // tuple TYPE grammar, but that is not a parse error).
        const source = "package P\nlet f = ((x int32)) -> x"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        let pattern = Assert.IsType[TupleDeconstructionPatternSyntax](lambda.Parameters[0].DeconstructionPattern)
        Assert.Single(pattern.Elements)
    }

    @Fact
    func MalformedDestructuringPattern_MissingElementType_ProducesDiagnostic() {
        // A C#-habit untyped destructuring `((x, y)) -> ...` still commits
        // to the lambda/destructuring-pattern path (not a confusing
        // tuple-expression error) and reports a real "expected a type"
        // diagnostic for the missing element type.
        const source = "package P\nlet f = ((x, y)) -> x"
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.True(lambda.Parameters[0].IsDestructured)
    }

    @Fact
    func MalformedDestructuringPattern_SecondElementMissingType_ProducesDiagnostic() {
        const source = "package P\nlet f = ((x int32, y)) -> x"
        let tree = SyntaxTree.Parse(source)
        Assert.NotEmpty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.True(lambda.Parameters[0].IsDestructured)
    }

    @Fact
    func Parses_DestructuredParameter_InArgumentPosition() {
        // Parser-only concern (undeclared `apply` produces only a BIND-time
        // diagnostic, which SyntaxTree.Parse's diagnostics never include) —
        // exercises the disambiguator inside an argument list, mirroring
        // Issue714LambdaParserTests.Parses_LambdaExpression_InArgumentPosition.
        const source = "package P\nlet v = apply(((x int32, y int32)) -> x + y)"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let lambda = FindFirst[LambdaExpressionSyntax](tree)
        Assert.True(lambda.Parameters[0].IsDestructured)
    }

    @Fact
    func Parses_ParenthesizedTupleExpression_NotMistakenForDestructuringLambda() {
        // A genuine parenthesized tuple EXPRESSION, unrelated to any lambda,
        // must remain unaffected by the new `(` opener check.
        const source = "package P\nlet v = (1, 2)"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.False(Walk(tree.Root).OfType[LambdaExpressionSyntax]().Any())
    }

    @Fact
    func DoublyParenthesizedNonPatternExpression_NotMistakenForDestructuringLambda() {
        // A reviewer-flagged edge case: `(` opening the first parameter slot
        // is ALSO the opener of an ordinary (here, doubly-parenthesized)
        // EXPRESSION, e.g. `((1 + 2))`. The first element slot of a genuine
        // destructuring pattern always starts with an identifier — `1` does
        // not — so this must fall back to the expression path (and its own,
        // unrelated diagnostic once `-> foo` follows a plain expression
        // statement) rather than being misparsed as a destructuring pattern
        // and reporting a confusing "expected identifier" cascade from
        // inside ParseTupleDeconstructionPattern.
        const source = "package P\nlet v = ((1 + 2)) -> foo"
        let tree = SyntaxTree.Parse(source)
        Assert.False(Walk(tree.Root).OfType[LambdaExpressionSyntax]().Any())
        Assert.False(Walk(tree.Root).OfType[TupleDeconstructionPatternSyntax]().Any())
    }

    shared {
        private func FindFirst[T SyntaxNode](tree SyntaxTree) T {
            return Walk(tree.Root).OfType[T]().First()
        }

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for c in node.GetChildren() {
                if c is SyntaxNode sn {
                    for d in Walk(sn) {
                        yield d
                    }
                }
            }
        }
    }
}

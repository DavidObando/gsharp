// <copyright file="Issue3421CheckedReferenceCastParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Parser coverage for issue #3421 checked reference conversion calls.
class Issue3421CheckedReferenceCastParserTests {
    @Fact
    func ParsesNonNullableAndNullableConversionCalls() {
        let tree = SyntaxTree.Parse(`func Cast(value object) string -> string(value)
func CastNullable(value object?) string? -> string?(value)
func CastSlice(value object) []object -> ([]object(value))[0..]
func CastGenericNullable(value object?) List[int32]? -> List[int32]?(value)
func CastUnambiguously(value object) string -> cast[string](value)`)
        Assert.Empty(tree.Diagnostics)
        let calls = Descendants(tree.Root)
            .OfType[CallExpressionSyntax]()
            .Where((call CallExpressionSyntax) -> call.Identifier.Text == "string")
            .ToArray()
        Assert.Equal(2, calls.Length)
        Assert.Null(calls[0].NullableQuestionToken)
        Assert.Equal(SyntaxKind.QuestionToken, calls[1].NullableQuestionToken?.Kind)
        Assert.Single(calls[0].Arguments)
        Assert.Single(calls[1].Arguments)
        let genericNullable = Assert.Single(
            Descendants(tree.Root).OfType[CallExpressionSyntax](),
            (call CallExpressionSyntax) -> call.TypeArgumentList != nil && call.NullableQuestionToken != nil
        )
        Assert.Equal(SyntaxKind.QuestionToken, genericNullable.NullableQuestionToken?.Kind)
        let compositeCalls = Descendants(tree.Root)
            .OfType[CallExpressionSyntax]()
            .Where((call CallExpressionSyntax) -> call.ConversionTypeClause != nil)
            .ToArray()
        Assert.Single(compositeCalls)
        Assert.All(compositeCalls, (call CallExpressionSyntax) -> Assert.Single(call.Arguments))
        let unambiguousCast = Assert.Single(
            Descendants(tree.Root).OfType[CallExpressionSyntax](),
            (call CallExpressionSyntax) -> call.Identifier.Text == "cast"
        )
        Assert.Single(unambiguousCast.TypeArgumentList!!.Arguments)
        Assert.Single(unambiguousCast.Arguments)
    }

    @Fact
    func SpacedQuestionAfterIndexerRemainsTernary() {
        let tree = SyntaxTree.Parse(`func Pick(d []bool, k int32, a int32, b int32) int32 -> d[k] ? (a) : b
func Sum(flags []bool, i int32, a int32, b int32) int32 -> flags[i] ? (a + b) : b
func CastNullable(value object?) List[int32]? -> List[int32]?(value)`)
        Assert.Empty(tree.Diagnostics)
        Assert.Equal(2, Descendants(tree.Root).OfType[ConditionalExpressionSyntax]().Count())
        Assert.Single(
            Descendants(tree.Root).OfType[CallExpressionSyntax](),
            (call CallExpressionSyntax) -> call.Identifier.Text == "List" && call.NullableQuestionToken != nil
        )
    }

    shared {
        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Descendants(child) {
                    yield descendant
                }
            }
        }
    }
}

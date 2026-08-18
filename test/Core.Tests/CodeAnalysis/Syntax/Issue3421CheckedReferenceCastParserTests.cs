// <copyright file="Issue3421CheckedReferenceCastParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for issue #3421 checked reference conversion calls.</summary>
public sealed class Issue3421CheckedReferenceCastParserTests
{
    [Fact]
    public void ParsesNonNullableAndNullableConversionCalls()
    {
        var tree = SyntaxTree.Parse("""
            func Cast(value object) string -> string(value)
            func CastNullable(value object?) string? -> string?(value)
            func CastSlice(value object) []object -> ([]object(value))[0..]
            func CastGenericNullable(value object?) List[int32]? -> List[int32]?(value)
            func CastUnambiguously(value object) string -> cast[string](value)
            """);

        Assert.Empty(tree.Diagnostics);
        var calls = Descendants(tree.Root)
            .OfType<CallExpressionSyntax>()
            .Where(call => call.Identifier.Text == "string")
            .ToArray();
        Assert.Equal(2, calls.Length);
        Assert.Null(calls[0].NullableQuestionToken);
        Assert.Equal(SyntaxKind.QuestionToken, calls[1].NullableQuestionToken?.Kind);
        Assert.Single(calls[0].Arguments);
        Assert.Single(calls[1].Arguments);
        var genericNullable = Assert.Single(
            Descendants(tree.Root).OfType<CallExpressionSyntax>(),
            call => call.TypeArgumentList != null && call.NullableQuestionToken != null);
        Assert.Equal(SyntaxKind.QuestionToken, genericNullable.NullableQuestionToken?.Kind);
        var compositeCalls = Descendants(tree.Root)
            .OfType<CallExpressionSyntax>()
            .Where(call => call.ConversionTypeClause != null)
            .ToArray();
        Assert.Single(compositeCalls);
        Assert.All(compositeCalls, call => Assert.Single(call.Arguments));
        var unambiguousCast = Assert.Single(
            Descendants(tree.Root).OfType<CallExpressionSyntax>(),
            call => call.Identifier.Text == "cast");
        Assert.Single(unambiguousCast.TypeArgumentList!.Arguments);
        Assert.Single(unambiguousCast.Arguments);
    }

    [Fact]
    public void SpacedQuestionAfterIndexerRemainsTernary()
    {
        var tree = SyntaxTree.Parse("""
            func Pick(d []bool, k int32, a int32, b int32) int32 -> d[k] ? (a) : b
            func Sum(flags []bool, i int32, a int32, b int32) int32 -> flags[i] ? (a + b) : b
            func CastNullable(value object?) List[int32]? -> List[int32]?(value)
            """);

        Assert.Empty(tree.Diagnostics);
        Assert.Equal(
            2,
            Descendants(tree.Root).OfType<ConditionalExpressionSyntax>().Count());
        Assert.Single(
            Descendants(tree.Root).OfType<CallExpressionSyntax>(),
            call => call.Identifier.Text == "List"
                && call.NullableQuestionToken != null);
    }

    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in Descendants(child))
            {
                yield return descendant;
            }
        }
    }
}

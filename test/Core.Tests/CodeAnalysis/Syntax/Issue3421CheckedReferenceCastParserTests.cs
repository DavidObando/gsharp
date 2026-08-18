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

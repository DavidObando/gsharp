// <copyright file="Adr0179NewlineSiteCoverageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public sealed class Adr0179NewlineSiteCoverageTests
{
    // Issue #4656: the inventoried sites are CALLS, found by a syntax walk in
    // the tree's own language (Roslyn for C#, the compiler's parser for G#),
    // keyed by the called name, the argument texts and a leading `!`. Comments
    // and string literals never match, whatever their nesting or quoting.
    private static readonly HashSet<string> NewlineSensitiveNames = new(StringComparer.Ordinal)
    {
        "IsCurrentOnNewLineAfter",
        "IsTokenOnNewLineAfter",
        "GetLineIndex",
    };

    [Fact]
    public void ParserNewlineSensitiveSites_AreExplicitlyInventoried()
    {
        string[] actual = TestSource.SourceFilesMatching("Parser*", SearchOption.TopDirectoryOnly, "src/Core/CodeAnalysis/Syntax")
            .Where(path => Path.GetFileNameWithoutExtension(path) != "Parser")
            .SelectMany(path => (TestSource.IsGSharp ? GSharpSites(path) : CSharpSites(path))
                .Select(site => Path.GetFileNameWithoutExtension(path) + ": " + site))
            .OrderBy(site => site, StringComparer.Ordinal)
            .ToArray();

        string[] expected =
        {
            "Parser.Expressions.Creation: !IsTokenOnNewLineAfter(Current, call.CloseParenthesisToken)",
            "Parser.Expressions.Creation: !IsTokenOnNewLineAfter(Peek(1), Current)",
            "Parser.Expressions.Creation: !IsTokenOnNewLineAfter(Peek(1), Current)",
            "Parser.Expressions.Creation: IsTokenOnNewLineAfter(Peek(pos), Peek(pos - 1))",
            "Parser.Expressions.Literals: IsTokenOnNewLineAfter(continuation, closeBrace)",
            "Parser.Expressions: !IsCurrentOnNewLineAfter(current)",
            "Parser.Expressions: !IsCurrentOnNewLineAfter(left)",
            "Parser.Expressions: IsCurrentOnNewLineAfter(dotDotToken)",
            "Parser.Expressions: IsCurrentOnNewLineAfter(left)",
            "Parser.Patterns: !IsTokenOnNewLineAfter(token, precedingNode)",
            "Parser.Patterns: IsTokenOnNewLineAfter(Current, trialType)",
            "Parser.Statements: GetLineIndex(Current.Span.Start)",
            "Parser.Statements: GetLineIndex(Current.Span.Start)",
            "Parser.Statements: GetLineIndex(Peek(1).Span.Start)",
            "Parser.Statements: GetLineIndex(keyword.Span.Start)",
            "Parser.Statements: GetLineIndex(keyword.Span.Start)",
        };

        Assert.Equal(expected.OrderBy(site => site, StringComparer.Ordinal), actual);
    }

    private static IEnumerable<string> CSharpSites(string path)
    {
        var root = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(File.ReadAllText(path), path: path).GetRoot();
        foreach (var invocation in root.DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax>())
        {
            string name = invocation.Expression switch
            {
                Microsoft.CodeAnalysis.CSharp.Syntax.IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
                Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax access => access.Name.Identifier.ValueText,
                _ => string.Empty,
            };
            if (!NewlineSensitiveNames.Contains(name))
            {
                continue;
            }

            // `!(F())`: the negation may sit outside parentheses.
            Microsoft.CodeAnalysis.SyntaxNode outer = invocation;
            while (outer.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax)
            {
                outer = outer.Parent;
            }

            bool negated = outer.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.PrefixUnaryExpressionSyntax prefix
                && prefix.OperatorToken.ValueText == "!";
            string arguments = string.Join(", ", invocation.ArgumentList.Arguments.Select(argument =>
                FromTokens(argument.DescendantTokens().Select(token => (token.Text, token.SpanStart)).ToList())));
            // Built first: G# reads `yield (` as a call to `yield` unless a
            // tuple follows, so a yielded expression must not open with a
            // parenthesis (#4703).
            string site = (negated ? "!" : string.Empty) + name + "(" + arguments + ")";
            yield return site;
        }
    }

    private static IEnumerable<string> GSharpSites(string path)
    {
        var tree = GSharpSourceSyntax.Parse(path);
        foreach (var call in tree.Root.DescendantNodes().OfType<CallExpressionSyntax>())
        {
            string name = GSharpSourceSyntax.SimpleName(call);
            if (!NewlineSensitiveNames.Contains(name))
            {
                continue;
            }

            // `!a.b.F()` negates the whole member access whose right part is the
            // call; `!(F())` puts parentheses in between.
            SyntaxNode outer = call;
            while ((outer.Parent is AccessorExpressionSyntax access && access.RightPart == outer)
                || outer.Parent is ParenthesizedExpressionSyntax)
            {
                outer = outer.Parent;
            }

            bool negated = outer.Parent is UnaryExpressionSyntax unary && unary.OperatorToken.Text == "!";
            string arguments = string.Join(", ", call.Arguments.Select(argument =>
                FromTokens(Tokens(argument).Select(token => (token.Text, token.Span.Start)).ToList())));
            // Built first: G# reads `yield (` as a call to `yield` unless a
            // tuple follows, so a yielded expression must not open with a
            // parenthesis (#4703).
            string site = (negated ? "!" : string.Empty) + name + "(" + arguments + ")";
            yield return site;
        }
    }

    // An argument's text rebuilt from its tokens, the same way in both
    // languages: a gap of whitespace between two tokens becomes one space, a gap
    // holding a comment also becomes one space, and no gap stays none. Comments,
    // line breaks and indentation therefore never enter the key.
    private static string FromTokens(IReadOnlyList<(string Text, int Start)> tokens)
    {
        var text = new System.Text.StringBuilder();
        for (var i = 0; i < tokens.Count; i++)
        {
            if (i > 0)
            {
                int previousEnd = tokens[i - 1].Start + tokens[i - 1].Text.Length;
                if (tokens[i].Start > previousEnd)
                {
                    text.Append(' ');
                }
            }

            text.Append(tokens[i].Text);
        }

        return text.ToString();
    }

    private static IEnumerable<SyntaxToken> Tokens(SyntaxNode node)
    {
        foreach (var child in node.GetChildren())
        {
            if (child is SyntaxToken token)
            {
                if (token.Text.Length > 0)
                {
                    yield return token;
                }
            }
            else
            {
                foreach (var nested in Tokens(child))
                {
                    yield return nested;
                }
            }
        }
    }
}

// <copyright file="Adr0179NewlineSiteCoverageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import System
import System.Collections.Generic
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Syntax
import Xunit
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Text

class Adr0179NewlineSiteCoverageTests {
    @Fact
    func ParserNewlineSensitiveSites_AreExplicitlyInventoried() {
        let actual = TestSource
            .SourceFilesMatching("Parser*", SearchOption.TopDirectoryOnly, "src/Core/CodeAnalysis/Syntax")
            .Where((path string) -> Path.GetFileNameWithoutExtension(path) != "Parser")
            .SelectMany(
            func (path string) IEnumerable[string] {
                return (
                    if TestSource.IsGSharp {
                        GSharpSites(path)
                    } else {
                        CSharpSites(path)
                    }
                ).Select((site string) -> (Path.GetFileNameWithoutExtension(path) + ": " + site))
            }
        )
            .OrderBy((site string) -> site, StringComparer.Ordinal)
            .ToArray()
        let expected[]string = []string{
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
            "Parser.Statements: GetLineIndex(keyword.Span.Start)"
        }
        Assert.Equal(expected.OrderBy((site string) -> site, StringComparer.Ordinal), actual)
    }

    shared {
        // Issue #4656: the inventoried sites are CALLS, found by a syntax walk in
        // the tree's own language (Roslyn for C#, the compiler's parser for G#),
        // keyed by the called name, the argument texts and a leading `!`. Comments
        // and string literals never match, whatever their nesting or quoting.
        private let NewlineSensitiveNames HashSet[string] = HashSet[string](StringComparer.Ordinal){
            "IsCurrentOnNewLineAfter",
            "IsTokenOnNewLineAfter",
            "GetLineIndex"
        }

        private func CSharpSites(path string) sequence[string] {
            let root = CSharpSyntaxTree.ParseText(File.ReadAllText(path), path: path).GetRoot()
            for invocation in root.DescendantNodes().OfType[InvocationExpressionSyntax]() {
                let name = switch invocation.Expression {
                    case identifier is IdentifierNameSyntax: identifier.Identifier.ValueText
                    case access is MemberAccessExpressionSyntax: access.Name.Identifier.ValueText
                    default: string.Empty
                }
                if !NewlineSensitiveNames.Contains(name) {
                    continue
                }
                // `!(F())`: the negation may sit outside parentheses.
                var outer Microsoft.CodeAnalysis.SyntaxNode? = invocation
                while outer!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                    outer = outer!!.Parent
                }
                let negated = outer!!.Parent is PrefixUnaryExpressionSyntax prefix &&
                    prefix
                    .OperatorToken
                    .ValueText == "!"
                let arguments = string.Join(
                    ", ",
                    invocation
                        .ArgumentList
                        .Arguments
                        .Select(
                        (argument ArgumentSyntax) -> FromTokens(
                            argument
                                .DescendantTokens()
                                .Select((token Microsoft.CodeAnalysis.SyntaxToken) -> (token.Text, token.SpanStart))
                                .ToList()
                        )
                    )
                )
                // Built first: G# reads `yield (` as a call to `yield` unless a
                // tuple follows, so a yielded expression must not open with a
                // parenthesis (#4703).
                let site = (
                    if negated {
                        "!"
                    } else {
                        string.Empty
                    }
                ) +
                    name +
                    "(" +
                    arguments +
                    ")"
                yield site
            }
        }

        private func GSharpSites(path string) sequence[string] {
            let tree GSharp.Core.CodeAnalysis.Syntax.SyntaxTree? = GSharpSourceSyntax.Parse(path)
            for call in tree!!.Root.DescendantNodes().OfType[CallExpressionSyntax]() {
                let name = GSharpSourceSyntax.SimpleName(call)
                if !NewlineSensitiveNames.Contains(name) {
                    continue
                }
                // `!a.b.F()` negates the whole member access whose right part is the
                // call; `!(F())` puts parentheses in between.
                var outer GSharp.Core.CodeAnalysis.Syntax.SyntaxNode? = call
                while (outer!!.Parent is AccessorExpressionSyntax access && access.RightPart == outer) ||
                    outer!!.Parent is GSharp
                    .Core
                    .CodeAnalysis
                    .Syntax
                    .ParenthesizedExpressionSyntax {
                    outer = outer!!.Parent
                }
                let negated = outer!!.Parent is UnaryExpressionSyntax unary && unary.OperatorToken.Text == "!"
                let arguments = string.Join(
                    ", ",
                    call.Arguments.Select(
                        (argument GSharp.Core.CodeAnalysis.Syntax.ExpressionSyntax) -> FromTokens(
                            Tokens(argument).Select(
                                (token GSharp.Core.CodeAnalysis.Syntax.SyntaxToken) -> (token.Text, token.Span.Start)
                            )
                                .ToList()
                        )
                    )
                )
                // Built first: G# reads `yield (` as a call to `yield` unless a
                // tuple follows, so a yielded expression must not open with a
                // parenthesis (#4703).
                let site = (
                    if negated {
                        "!"
                    } else {
                        string.Empty
                    }
                ) +
                    name +
                    "(" +
                    arguments +
                    ")"
                yield site
            }
        }

        // An argument's text rebuilt from its tokens, the same way in both
        // languages: a gap of whitespace between two tokens becomes one space, a gap
        // holding a comment also becomes one space, and no gap stays none. Comments,
        // line breaks and indentation therefore never enter the key.
        private func FromTokens(tokens IReadOnlyList[(Text string, Start int32)]) string {
            let text = StringBuilder()
            for var i = 0; i < tokens.Count; i++ {
                if i > 0 {
                    let previousEnd = tokens[i - 1].Start + tokens[i - 1].Text.Length
                    if tokens[i].Start > previousEnd {
                        text.Append(' ')
                    }
                }
                text.Append(tokens[i].Text)
            }
            return text.ToString()
        }

        private func Tokens(node GSharp.Core.CodeAnalysis.Syntax.SyntaxNode) sequence[
            GSharp.Core.CodeAnalysis.Syntax.SyntaxToken
        ] {
            for child in node.GetChildren() {
                if child is GSharp.Core.CodeAnalysis.Syntax.SyntaxToken token {
                    if token.Text.Length > 0 {
                        yield token
                    }
                } else {
                    for nested in Tokens(child) {
                        yield nested
                    }
                }
            }
        }
    }
}

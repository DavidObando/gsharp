// <copyright file="Highlight.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Repl.Tokens;
using Spectre.Console;

namespace GSharp.Repl.Engine;

/// <summary>Turns a line of G# into themed Spectre markup using the lexer.</summary>
public static class Highlight
{
    public static string Markup(string line)
    {
        if (string.IsNullOrEmpty(line))
        {
            return string.Empty;
        }

        var sb = new StringBuilder();
        foreach (var token in SyntaxTree.ParseTokens(line))
        {
            if (string.IsNullOrEmpty(token.Text))
            {
                continue;
            }

            foreach (var (_, text, color) in ExpandToken(token))
            {
                if (string.IsNullOrEmpty(text))
                {
                    continue;
                }

                sb.Append('[').Append(color.Value.ToMarkup()).Append(']')
                  .Append(Spectre.Console.Markup.Escape(text))
                  .Append("[/]");
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// Highlights a full line in one lex pass, drawing a reverse-video block cursor
    /// at <paramref name="cursorCol"/> without splitting the token under the caret.
    /// </summary>
    public static string MarkupWithCursor(string line, int cursorCol, string cursorMarkup)
    {
        var sb = new StringBuilder();
        var rendered = 0;
        foreach (var token in SyntaxTree.ParseTokens(line))
        {
            if (string.IsNullOrEmpty(token.Text))
            {
                continue;
            }

            foreach (var (start, text, color) in ExpandToken(token))
            {
                if (string.IsNullOrEmpty(text))
                {
                    continue;
                }

                var colorMarkup = color.Value.ToMarkup();
                for (var i = 0; i < text.Length; i++)
                {
                    var ch = Spectre.Console.Markup.Escape(text[i].ToString());
                    var open = start + i == cursorCol ? cursorMarkup : colorMarkup;
                    sb.Append('[').Append(open).Append(']').Append(ch).Append("[/]");
                }

                rendered = start + text.Length;
            }
        }

        if (cursorCol >= rendered)
        {
            sb.Append('[').Append(cursorMarkup).Append("] [/]");
        }

        return sb.ToString();
    }

    /// <summary>
    /// Splits a single lexed token into absolutely-positioned (start, text, color) spans.
    /// Every token except <see cref="SyntaxKind.InterpolatedStringToken"/> is a single span
    /// colored by its own kind. An interpolated string's holes (<c>${expr}</c> / <c>$ident</c>)
    /// are re-lexed and colored individually — without this, the whole literal (including any
    /// holes) falls through <see cref="ColorFor"/>'s default case and renders as one flat color.
    /// </summary>
    private static IEnumerable<(int Start, string Text, SemanticColor Color)> ExpandToken(SyntaxToken token)
    {
        if (token.Kind == SyntaxKind.InterpolatedStringToken && token.Value is ImmutableArray<InterpolationFragment> fragments)
        {
            var cursor = token.Position;
            var tokenEnd = token.Position + token.Text.Length;
            var stringColor = Tokens.Tokens.StringLit;

            foreach (var frag in fragments)
            {
                if (!frag.IsExpression)
                {
                    // Literal-fragment positions aren't populated by the lexer (see
                    // InterpolationFragment.FromText); the literal span is instead whatever
                    // lies between the previous hole's end and this hole's start below.
                    continue;
                }

                if (frag.Position > cursor)
                {
                    yield return (cursor, token.Text.Substring(cursor - token.Position, frag.Position - cursor), stringColor);
                }

                foreach (var exprToken in SyntaxTree.ParseTokens(frag.Text))
                {
                    if (string.IsNullOrEmpty(exprToken.Text))
                    {
                        continue;
                    }

                    yield return (frag.Position + exprToken.Position, exprToken.Text, ColorFor(exprToken.Kind));
                }

                cursor = frag.Position + frag.Text.Length;
            }

            if (tokenEnd > cursor)
            {
                yield return (cursor, token.Text.Substring(cursor - token.Position, tokenEnd - cursor), stringColor);
            }

            yield break;
        }

        yield return (token.Position, token.Text, ColorFor(token.Kind));
    }

    private static SemanticColor ColorFor(SyntaxKind kind)
    {
        if (kind.ToString().EndsWith("Keyword", System.StringComparison.Ordinal))
        {
            return Tokens.Tokens.Keyword;
        }

        return kind switch
        {
            SyntaxKind.NumberToken => Tokens.Tokens.Number,
            SyntaxKind.StringToken => Tokens.Tokens.StringLit,
            SyntaxKind.CommentToken => Tokens.Tokens.Comment,
            SyntaxKind.IdentifierToken => Tokens.Tokens.Identifier,
            _ => Tokens.Tokens.TextTertiary,
        };
    }
}

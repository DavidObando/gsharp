// <copyright file="Highlight.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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

            var color = ColorFor(token.Kind);
            sb.Append('[').Append(color.Value.ToMarkup()).Append(']')
              .Append(Spectre.Console.Markup.Escape(token.Text))
              .Append("[/]");
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
            var text = token.Text;
            if (string.IsNullOrEmpty(text))
            {
                continue;
            }

            var color = ColorFor(token.Kind).Value.ToMarkup();
            for (var i = 0; i < text.Length; i++)
            {
                var ch = Spectre.Console.Markup.Escape(text[i].ToString());
                var open = token.Position + i == cursorCol ? cursorMarkup : color;
                sb.Append('[').Append(open).Append(']').Append(ch).Append("[/]");
            }

            rendered = token.Position + text.Length;
        }

        if (cursorCol >= rendered)
        {
            sb.Append('[').Append(cursorMarkup).Append("] [/]");
        }

        return sb.ToString();
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

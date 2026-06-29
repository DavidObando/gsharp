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

// <copyright file="FormattingEngine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Text;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.LanguageServer;

/// <summary>
/// Formats GSharp source code by re-lexing and applying canonical whitespace rules.
/// </summary>
internal static class FormattingEngine
{
    private const string Indent = "  ";

    /// <summary>
    /// Format the entire source text.
    /// </summary>
    /// <param name="source">Source code to format.</param>
    /// <returns>Formatted source code.</returns>
    public static string Format(string source)
    {
        var tokens = SyntaxTree.ParseTokens(source);
        var sb = new StringBuilder();
        var depth = 0;
        var lineStart = true;
        SyntaxKind prevKind = SyntaxKind.BadToken;
        var prevWasNewline = true;

        for (var i = 0; i < tokens.Length; i++)
        {
            var token = tokens[i];

            if (token.Kind == SyntaxKind.WhitespaceToken)
            {
                continue;
            }

            if (token.Kind == SyntaxKind.BadToken)
            {
                // Preserve bad tokens as-is to avoid losing content
                if (token.Text == "\n" || token.Text == "\r\n")
                {
                    sb.AppendLine();
                    lineStart = true;
                    prevWasNewline = true;
                }
                else
                {
                    sb.Append(token.Text);
                }

                prevKind = token.Kind;
                continue;
            }

            // Handle close brace — decrease depth before writing
            if (token.Kind == SyntaxKind.CloseBraceToken)
            {
                depth = Math.Max(0, depth - 1);
            }

            // Determine if we need a newline before this token
            var needsNewlineBefore = ShouldNewlineBefore(token.Kind, prevKind, prevWasNewline);

            if (needsNewlineBefore && !prevWasNewline)
            {
                sb.AppendLine();
                lineStart = true;
                prevWasNewline = true;
            }

            // Write indentation if at start of line
            if (lineStart && !prevWasNewline)
            {
                WriteIndent(sb, depth);
                lineStart = false;
            }
            else if (prevWasNewline)
            {
                WriteIndent(sb, depth);
                lineStart = false;
                prevWasNewline = false;
            }
            else
            {
                // Write spacing between tokens on same line
                if (NeedsSpaceBefore(token.Kind, prevKind))
                {
                    sb.Append(' ');
                }
            }

            sb.Append(token.Text);
            prevKind = token.Kind;

            // Handle open brace — increase depth after writing
            if (token.Kind == SyntaxKind.OpenBraceToken)
            {
                depth++;
                sb.AppendLine();
                lineStart = true;
                prevWasNewline = true;
            }
            else if (token.Kind == SyntaxKind.CloseBraceToken)
            {
                // Newline after close brace
                sb.AppendLine();
                lineStart = true;
                prevWasNewline = true;
            }
            else if (token.Kind == SyntaxKind.CommentToken)
            {
                sb.AppendLine();
                lineStart = true;
                prevWasNewline = true;
            }
        }

        // Ensure file ends with newline
        var result = sb.ToString();
        if (result.Length > 0 && result[^1] != '\n')
        {
            result += Environment.NewLine;
        }

        return result;
    }

    private static bool ShouldNewlineBefore(SyntaxKind current, SyntaxKind previous, bool alreadyNewline)
    {
        if (alreadyNewline)
        {
            return false;
        }

        // Top-level declarations on new lines
        if (current == SyntaxKind.FuncKeyword || current == SyntaxKind.TypeKeyword ||
            current == SyntaxKind.ImportKeyword || current == SyntaxKind.PackageKeyword ||
            current == SyntaxKind.StructKeyword || current == SyntaxKind.InterfaceKeyword)
        {
            if (previous != SyntaxKind.BadToken && previous != SyntaxKind.CommentToken)
            {
                return true;
            }
        }

        return false;
    }

    private static bool NeedsSpaceBefore(SyntaxKind current, SyntaxKind previous)
    {
        // No space after open paren/bracket
        if (previous == SyntaxKind.OpenParenthesisToken || previous == SyntaxKind.OpenSquareBracketToken)
        {
            return false;
        }

        // No space before close paren/bracket
        if (current == SyntaxKind.CloseParenthesisToken || current == SyntaxKind.CloseSquareBracketToken)
        {
            return false;
        }

        // No space before comma, semicolon
        if (current == SyntaxKind.CommaToken || current == SyntaxKind.SemicolonToken)
        {
            return false;
        }

        // No space after dot
        if (previous == SyntaxKind.DotToken)
        {
            return false;
        }

        // No space before dot
        if (current == SyntaxKind.DotToken)
        {
            return false;
        }

        // No space before colon in field init (but yes after)
        if (current == SyntaxKind.ColonToken)
        {
            return false;
        }

        // Space after comma
        if (previous == SyntaxKind.CommaToken)
        {
            return true;
        }

        // Space after colon
        if (previous == SyntaxKind.ColonToken)
        {
            return true;
        }

        // Space around operators and keywords
        return true;
    }

    private static void WriteIndent(StringBuilder sb, int depth)
    {
        for (var i = 0; i < depth; i++)
        {
            sb.Append(Indent);
        }
    }
}

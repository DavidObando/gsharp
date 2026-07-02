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
public static class FormattingEngine
{
    private const string DefaultIndent = "  ";

    /// <summary>
    /// Format the entire source text using the default two-space indent.
    /// </summary>
    /// <param name="source">Source code to format.</param>
    /// <returns>Formatted source code.</returns>
    public static string Format(string source) => Format(source, DefaultIndent);

    /// <summary>
    /// Format the entire source text.
    /// </summary>
    /// <param name="source">Source code to format.</param>
    /// <param name="indent">The unit of indentation to apply per nesting depth (for example two spaces, four spaces, or a tab).</param>
    /// <returns>Formatted source code.</returns>
    public static string Format(string source, string indent)
    {
        if (string.IsNullOrEmpty(indent))
        {
            indent = DefaultIndent;
        }

        var tokens = SyntaxTree.ParseTokens(source);
        var sb = new StringBuilder();
        var depth = 0;
        var lineStart = true;
        SyntaxKind prevKind = SyntaxKind.BadToken;
        var prevWasNewline = true;

        // The lexer folds source line breaks into the text of WhitespaceToken, so the only way
        // to know the user had a line break between two tokens is to inspect that text.
        var hadUserNewline = false;

        for (var i = 0; i < tokens.Length; i++)
        {
            var token = tokens[i];

            if (token.Kind == SyntaxKind.WhitespaceToken)
            {
                if (token.Text.Contains('\n'))
                {
                    hadUserNewline = true;
                }

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
            var needsNewlineBefore = ShouldNewlineBefore(token.Kind, prevKind, prevWasNewline, hadUserNewline);
            hadUserNewline = false;

            if (needsNewlineBefore && !prevWasNewline)
            {
                sb.AppendLine();
                lineStart = true;
                prevWasNewline = true;
            }

            // Write indentation if at start of line
            if (lineStart && !prevWasNewline)
            {
                WriteIndent(sb, depth, indent);
                lineStart = false;
            }
            else if (prevWasNewline)
            {
                WriteIndent(sb, depth, indent);
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

    private static bool ShouldNewlineBefore(SyntaxKind current, SyntaxKind previous, bool alreadyNewline, bool hadUserNewline)
    {
        if (alreadyNewline)
        {
            return false;
        }

        // A closing brace always starts its own line, regardless of how the user wrote it,
        // so nested blocks (scope/if/try/select/struct/etc.) never glue their last statement
        // to the brace that closes them.
        if (current == SyntaxKind.CloseBraceToken)
        {
            return true;
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

        // Preserve line breaks the user had, so multi-statement bodies keep one statement per
        // line instead of collapsing (issue #1660). Tokens that continue the previous expression
        // (closing brackets, punctuation) never start a new line even if the source had a break
        // right before them.
        if (hadUserNewline && !IsContinuationToken(current))
        {
            return true;
        }

        return false;
    }

    private static bool IsContinuationToken(SyntaxKind kind)
    {
        return kind == SyntaxKind.CloseParenthesisToken ||
               kind == SyntaxKind.CloseSquareBracketToken ||
               kind == SyntaxKind.CommaToken ||
               kind == SyntaxKind.DotToken ||
               kind == SyntaxKind.ColonToken ||
               kind == SyntaxKind.SemicolonToken;
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

    private static void WriteIndent(StringBuilder sb, int depth, string indent)
    {
        for (var i = 0; i < depth; i++)
        {
            sb.Append(indent);
        }
    }
}

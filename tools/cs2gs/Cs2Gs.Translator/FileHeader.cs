// <copyright file="FileHeader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

/// <summary>
/// Finds a C# file's header comment, such as a license or copyright block, so
/// the translation can keep it at the top of the G# file.
/// </summary>
/// <remarks>
/// The header is the run of <c>//</c> and <c>/* */</c> comments at the start
/// of the file, after any leading blank lines (nothing else carries a comment
/// in the first token's leading trivia, so it is kept rather than dropped). It ends at the first blank line, preprocessor directive,
/// documentation comment, or token. A run that ends directly on a member
/// declaration with no blank line belongs to that declaration, and
/// <c>AttachSourceComments</c> carries it there instead. This class owns the
/// decision: a comment inside <see cref="TryGetSpan"/> belongs to the header
/// and to nothing else.
/// </remarks>
internal static class FileHeader
{
    // The line ending the last comment plus the empty line after it.
    private const int BlankLineBreaks = 2;

    /// <summary>
    /// Gets the header's comment lines: the source text split at every C# line
    /// terminator, with trailing whitespace trimmed from each line. The printer
    /// joins them with <c>\n</c>.
    /// </summary>
    /// <param name="root">The C# compilation unit.</param>
    /// <returns>The header lines, or an empty list when the file has no header.</returns>
    public static IReadOnlyList<string> GetLines(CompilationUnitSyntax root)
    {
        if (!TryGetSpan(root, out TextSpan span))
        {
            return Array.Empty<string>();
        }

        // One item per source line, using Roslyn's own line model: it breaks
        // lines at every C# line terminator (\r\n, \r, \n, U+0085, U+2028,
        // U+2029), exactly as the parser that ended each comment did.
        SourceText text = root.SyntaxTree.GetText();
        int first = text.Lines.GetLineFromPosition(span.Start).LineNumber;
        int last = text.Lines.GetLineFromPosition(span.End).LineNumber;
        var lines = new List<string>(last - first + 1);
        for (int number = first; number <= last; number++)
        {
            // Whole source lines from their start, so indentation before the
            // first comment is kept like the indentation of the lines after it
            // (only whitespace precedes the header on its first line).
            TextLine line = text.Lines[number];
            int start = line.Start;
            int end = Math.Min(line.End, span.End);
            lines.Add(text.ToString(TextSpan.FromBounds(start, end)).TrimEnd());
        }

        return lines;
    }

    /// <summary>
    /// Gets the span of the header comments, from the first comment's start to
    /// the last comment's end.
    /// </summary>
    /// <param name="root">The C# compilation unit.</param>
    /// <param name="span">The header's span when there is one.</param>
    /// <returns><see langword="true"/> when the file has a header.</returns>
    public static bool TryGetSpan(CompilationUnitSyntax root, out TextSpan span)
    {
        span = default;
        SyntaxToken first = root.GetFirstToken(includeZeroWidth: true);
        int start = -1;
        int end = -1;

        // Line breaks since the last comment. Whitespace does not reset the
        // count, so a line holding only spaces still counts as blank: two
        // breaks in a row end the header.
        int lineBreaks = 0;
        bool endedBeforeToken = false;
        foreach (SyntaxTrivia trivia in first.LeadingTrivia)
        {
            if (trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineCommentTrivia))
            {
                start = start < 0 ? trivia.SpanStart : start;
                end = trivia.Span.End;
                lineBreaks = 0;
            }
            else if (trivia.IsKind(SyntaxKind.EndOfLineTrivia))
            {
                lineBreaks++;
                if (lineBreaks >= BlankLineBreaks && start >= 0)
                {
                    endedBeforeToken = true;
                    break;
                }
            }
            else if (!trivia.IsKind(SyntaxKind.WhitespaceTrivia))
            {
                // A directive or a documentation comment ends the header.
                endedBeforeToken = true;
                break;
            }
        }

        if (start < 0 || (!endedBeforeToken && StartsMemberDeclaration(first)))
        {
            return false;
        }

        span = TextSpan.FromBounds(start, end);
        return true;
    }

    // A member or global statement that starts the file owns the comments
    // directly above it, and so does an attribute list on that member, because
    // the member declaration contains it. A namespace, a using directive and a
    // file-level [assembly:]/[module:] attribute list carry no comments of
    // their own, so a run above them is the file's header; treating it
    // otherwise would drop it.
    private static bool StartsMemberDeclaration(SyntaxToken token)
    {
        for (SyntaxNode node = token.Parent; node is not null; node = node.Parent)
        {
            if (node is BaseNamespaceDeclarationSyntax || node is CompilationUnitSyntax)
            {
                return false;
            }

            if (node is MemberDeclarationSyntax)
            {
                return true;
            }
        }

        return false;
    }
}

// <copyright file="FileHeader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq

/// Finds a C# file's header comment, such as a license or copyright block, so
/// the translation can keep it at the top of the G# file.
/// @remarks The header is the run of `//` and `/* */` comments at the start
/// of the file, after any leading blank lines (nothing else carries a comment
/// in the first token's leading trivia, so it is kept rather than dropped). It ends at the first blank
/// line, preprocessor directive,
/// documentation comment, or token. A run that ends directly on a member
/// declaration with no blank line belongs to that declaration, and
/// `AttachSourceComments` carries it there instead. This class owns the
/// decision: a comment inside (cref:TryGetSpan) belongs to the header
/// and to nothing else.
internal shared class FileHeader {
    // The line ending the last comment plus the empty line after it.
    private const BlankLineBreaks int32 = 2

    /// Gets the header's comment lines: the source text split at every C# line
    /// terminator, with trailing whitespace trimmed from each line. The printer
    /// joins them with `\n`.
    /// @param root The C# compilation unit.
    /// @returns The header lines, or an empty list when the file has no header.
    func GetLines(root CompilationUnitSyntax) IReadOnlyList[string] {
        if !TryGetSpan(root, out var span) {
            return Array.Empty[string]()
        }
        // One item per source line, using Roslyn's own line model: it breaks
        // lines at every C# line terminator (\r\n, \r, \n, U+0085, U+2028,
        // U+2029), exactly as the parser that ended each comment did.
        let text = root.SyntaxTree.GetText()
        let first = text.Lines.GetLineFromPosition(span.Start).LineNumber
        let last = text.Lines.GetLineFromPosition(span.End).LineNumber
        let lines = List[string](last - first + 1)
        for var number = first; number <= last; number++ {
            // Whole source lines from their start, so indentation before the
            // first comment is kept like the indentation of the lines after it
            // (only whitespace precedes the header on its first line).
            let line = text.Lines[number]
            let start = line.Start
            let end = Math.Min(line.End, span.End)
            lines.Add(text.ToString(TextSpan.FromBounds(start, end)).TrimEnd())
        }
        return lines
    }

    /// Gets the span of the header comments, from the first comment's start to
    /// the last comment's end.
    /// @param root The C# compilation unit.
    /// @param span The header's span when there is one.
    /// @returns `true` when the file has a header.
    func TryGetSpan(root CompilationUnitSyntax, out span TextSpan) bool {
        span = default(TextSpan)
        let first = root.GetFirstToken(includeZeroWidth: true)
        var start = -1
        var end = -1
        // Line breaks since the last comment. Whitespace does not reset the
        // count, so a line holding only spaces still counts as blank: two
        // breaks in a row end the header.
        var lineBreaks = 0
        var endedBeforeToken = false
        for trivia in first.LeadingTrivia {
            if trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineCommentTrivia) {
                start = if start < 0 {
                    trivia.SpanStart
                } else {
                    start
                }
                end = trivia.Span.End
                lineBreaks = 0
            } else if trivia.IsKind(SyntaxKind.EndOfLineTrivia) {
                lineBreaks++
                if lineBreaks >= BlankLineBreaks && start >= 0 {
                    endedBeforeToken = true
                    break
                }
            } else if !trivia.IsKind(SyntaxKind.WhitespaceTrivia) {
                // A directive or a documentation comment ends the header.
                endedBeforeToken = true
                break
            }
        }
        if start < 0 || (!endedBeforeToken && StartsMemberDeclaration(first)) {
            return false
        }
        span = TextSpan.FromBounds(start, end)
        return true
    }

    // A member or global statement that starts the file owns the comments
    // directly above it, and so does an attribute list on that member, because
    // the member declaration contains it. A namespace, a using directive and a
    // file-level [assembly:]/[module:] attribute list carry no comments of
    // their own, so a run above them is the file's header; treating it
    // otherwise would drop it.
    private func StartsMemberDeclaration(token SyntaxToken) bool {
        for var node SyntaxNode? = token.Parent; node != nil; node = node!!.Parent {
            if node is BaseNamespaceDeclarationSyntax || node is CompilationUnitSyntax {
                return false
            }
            if node is MemberDeclarationSyntax {
                return true
            }
        }
        return false
    }
}

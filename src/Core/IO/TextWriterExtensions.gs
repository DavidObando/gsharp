// <copyright file="TextWriterExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.IO

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.CodeDom.Compiler
import System.Collections.Generic
import System.IO
import System.Linq

/// Utility extensions to the (cref:TextWriter) class.
shared class TextWriterExtensions { }

/// Writes a keyword.
/// @param kind The keyworkd kind.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WriteKeyword(kind SyntaxKind) {
    writer.WriteKeyword(SyntaxFacts.GetTextOrEmpty(kind))
}

/// Writes a keyword.
/// @param text The keyword.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WriteKeyword(text string) {
    writer.SetForeground(ConsoleColor.Blue)
    writer.Write(text)
    writer.ResetColor()
}

/// Writes an identifier.
/// @param text The identifier.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WriteIdentifier(text string) {
    writer.SetForeground(ConsoleColor.DarkYellow)
    writer.Write(text)
    writer.ResetColor()
}

/// Writes a number.
/// @param text The number.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WriteNumber(text string) {
    writer.SetForeground(ConsoleColor.Cyan)
    writer.Write(text)
    writer.ResetColor()
}

/// Writes a string.
/// @param text The string.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WriteString(text string) {
    writer.SetForeground(ConsoleColor.Magenta)
    writer.Write(text)
    writer.ResetColor()
}

/// Write a space.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WriteSpace() {
    writer.WritePunctuation(" ")
}

/// Writes punctuation.
/// @param kind The syntax kind.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WritePunctuation(kind SyntaxKind) {
    writer.WritePunctuation(SyntaxFacts.GetTextOrEmpty(kind))
}

/// Writes punctuation.
/// @param text The punctuation.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WritePunctuation(text string) {
    writer.SetForeground(ConsoleColor.DarkGray)
    writer.Write(text)
    writer.ResetColor()
}

/// Writes the diagnostics to this text writer.
/// @param diagnostics The diagnostics.
@ExtensionOwner(typeof(TextWriterExtensions))
func (writer TextWriter) WriteDiagnostics(diagnostics IEnumerable[Diagnostic]) {
    for diagnostic in diagnostics.OrderBy((diag Diagnostic) -> diag.Location) {
        writer.WriteLine()
        let severityColor = switch diagnostic.Severity {
            case DiagnosticSeverity.Error: ConsoleColor.DarkRed
            case DiagnosticSeverity.Warning: ConsoleColor.DarkYellow
            default: ConsoleColor.DarkCyan
        }
        let severityLabel = switch diagnostic.Severity {
            case DiagnosticSeverity.Error: "error"
            case DiagnosticSeverity.Warning: "warning"
            default: "info"
        }
        // Issue #2144: a location-less diagnostic (default(TextLocation),
        // so Text == null — e.g. a synthesized or assembly-level
        // diagnostic) has no file/position/snippet to render. Emit just
        // the severity/id/message so a single such diagnostic no longer
        // NREs and masks the whole batch.
        if diagnostic.Location.Text is not SourceText sourceText {
            writer.SetForeground(severityColor)
            writer.Write("$severityLabel ${diagnostic.Id}: ")
            writer.WriteLine(diagnostic.Message)
            writer.ResetColor()
            continue
        }
        writer.SetForeground(severityColor)
        writer.Write(
            "${diagnostic.Location.FileName}(${diagnostic.Location.StartLine + 1},${diagnostic.Location.StartCharacter + 1},${diagnostic.Location.EndLine + 1},${diagnostic.Location.EndCharacter + 1}): "
        )
        writer.Write("$severityLabel ${diagnostic.Id}: ")
        writer.WriteLine(diagnostic.Message)
        writer.ResetColor()
        // Render the snippet relative to the line containing the start of the
        // diagnostic span. When the span crosses line boundaries the span end can
        // be far past the end of the start line, so clamp every boundary to the
        // start line to keep all computed lengths non-negative.
        let startLine = sourceText.Lines[diagnostic.Location.StartLine]
        let spanStart = Math.Clamp(diagnostic.Location.Span.Start, startLine.Start, startLine.End)
        let spanEnd = Math.Clamp(diagnostic.Location.Span.End, spanStart, startLine.End)
        let prefixSpan = TextSpan.FromBounds(startLine.Start, spanStart)
        let errorSpan = TextSpan.FromBounds(spanStart, spanEnd)
        let suffixSpan = TextSpan.FromBounds(spanEnd, startLine.End)
        let prefix = sourceText.ToString(prefixSpan)
        let error = sourceText.ToString(errorSpan)
        let suffix = sourceText.ToString(suffixSpan)
        writer.Write("    ")
        writer.Write(prefix)
        writer.SetForeground(severityColor)
        writer.Write(error)
        writer.ResetColor()
        writer.Write(suffix)
        writer.WriteLine()
    }
    writer.WriteLine()
}

@ExtensionOwner(typeof(TextWriterExtensions))
private func (writer TextWriter) IsConsoleOut() bool {
    if writer == Console.Out {
        return true
    }
    if writer is IndentedTextWriter iw && iw.InnerWriter.IsConsoleOut() {
        return true
    }
    return false
}

@ExtensionOwner(typeof(TextWriterExtensions))
private func (writer TextWriter) SetForeground(color ConsoleColor) {
    if writer.IsConsoleOut() {
        Console.ForegroundColor = color
    }
}

@ExtensionOwner(typeof(TextWriterExtensions))
private func (writer TextWriter) ResetColor() {
    if writer.IsConsoleOut() {
        Console.ResetColor()
    }
}

// <copyright file="TextWriterExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.IO;

/// <summary>
/// Utility extensions to the <see cref="TextWriter"/> class.
/// </summary>
public static class TextWriterExtensions
{
    /// <summary>
    /// Writes a keyword.
    /// </summary>
    /// <param name="writer">The writer.</param>
    /// <param name="kind">The keyworkd kind.</param>
    public static void WriteKeyword(this TextWriter writer, SyntaxKind kind)
    {
        writer.WriteKeyword(SyntaxFacts.GetText(kind));
    }

    /// <summary>
    /// Writes a keyword.
    /// </summary>
    /// <param name="writer">The writer.</param>
    /// <param name="text">The keyword.</param>
    public static void WriteKeyword(this TextWriter writer, string text)
    {
        writer.SetForeground(ConsoleColor.Blue);
        writer.Write(text);
        writer.ResetColor();
    }

    /// <summary>
    /// Writes an identifier.
    /// </summary>
    /// <param name="writer">The writer.</param>
    /// <param name="text">The identifier.</param>
    public static void WriteIdentifier(this TextWriter writer, string text)
    {
        writer.SetForeground(ConsoleColor.DarkYellow);
        writer.Write(text);
        writer.ResetColor();
    }

    /// <summary>
    /// Writes a number.
    /// </summary>
    /// <param name="writer">The writer.</param>
    /// <param name="text">The number.</param>
    public static void WriteNumber(this TextWriter writer, string text)
    {
        writer.SetForeground(ConsoleColor.Cyan);
        writer.Write(text);
        writer.ResetColor();
    }

    /// <summary>
    /// Writes a string.
    /// </summary>
    /// <param name="writer">The writer.</param>
    /// <param name="text">The string.</param>
    public static void WriteString(this TextWriter writer, string text)
    {
        writer.SetForeground(ConsoleColor.Magenta);
        writer.Write(text);
        writer.ResetColor();
    }

    /// <summary>
    /// Write a space.
    /// </summary>
    /// <param name="writer">The writer.</param>
    public static void WriteSpace(this TextWriter writer)
    {
        writer.WritePunctuation(" ");
    }

    /// <summary>
    /// Writes punctuation.
    /// </summary>
    /// <param name="writer">The writer.</param>
    /// <param name="kind">The syntax kind.</param>
    public static void WritePunctuation(this TextWriter writer, SyntaxKind kind)
    {
        writer.WritePunctuation(SyntaxFacts.GetText(kind));
    }

    /// <summary>
    /// Writes punctuation.
    /// </summary>
    /// <param name="writer">The writer.</param>
    /// <param name="text">The punctuation.</param>
    public static void WritePunctuation(this TextWriter writer, string text)
    {
        writer.SetForeground(ConsoleColor.DarkGray);
        writer.Write(text);
        writer.ResetColor();
    }

    /// <summary>
    /// Writes the diagnostics to this text writer.
    /// </summary>
    /// <param name="writer">The text writer.</param>
    /// <param name="diagnostics">The diagnostics.</param>
    public static void WriteDiagnostics(this TextWriter writer, IEnumerable<Diagnostic> diagnostics)
    {
        foreach (var diagnostic in diagnostics.OrderBy(diag => diag.Location))
        {
            writer.WriteLine();

            var severityColor = diagnostic.Severity switch
            {
                DiagnosticSeverity.Error => ConsoleColor.DarkRed,
                DiagnosticSeverity.Warning => ConsoleColor.DarkYellow,
                _ => ConsoleColor.DarkCyan,
            };
            var severityLabel = diagnostic.Severity switch
            {
                DiagnosticSeverity.Error => "error",
                DiagnosticSeverity.Warning => "warning",
                _ => "info",
            };

            // Issue #2144: a location-less diagnostic (default(TextLocation),
            // so Text == null — e.g. a synthesized or assembly-level
            // diagnostic) has no file/position/snippet to render. Emit just
            // the severity/id/message so a single such diagnostic no longer
            // NREs and masks the whole batch.
            if (diagnostic.Location.Text is null)
            {
                writer.SetForeground(severityColor);
                writer.Write($"{severityLabel} {diagnostic.Id}: ");
                writer.WriteLine(diagnostic.Message);
                writer.ResetColor();
                continue;
            }

            writer.SetForeground(severityColor);
            writer.Write($"{diagnostic.Location.FileName}({diagnostic.Location.StartLine + 1},{diagnostic.Location.StartCharacter + 1},{diagnostic.Location.EndLine + 1},{diagnostic.Location.EndCharacter + 1}): ");
            writer.Write($"{severityLabel} {diagnostic.Id}: ");
            writer.WriteLine(diagnostic.Message);
            writer.ResetColor();

            // Render the snippet relative to the line containing the start of the
            // diagnostic span. When the span crosses line boundaries the span end can
            // be far past the end of the start line, so clamp every boundary to the
            // start line to keep all computed lengths non-negative.
            var startLine = diagnostic.Location.Text.Lines[diagnostic.Location.StartLine];

            var spanStart = Math.Clamp(diagnostic.Location.Span.Start, startLine.Start, startLine.End);
            var spanEnd = Math.Clamp(diagnostic.Location.Span.End, spanStart, startLine.End);

            var prefixSpan = TextSpan.FromBounds(startLine.Start, spanStart);
            var errorSpan = TextSpan.FromBounds(spanStart, spanEnd);
            var suffixSpan = TextSpan.FromBounds(spanEnd, startLine.End);

            var prefix = diagnostic.Location.Text.ToString(prefixSpan);
            var error = diagnostic.Location.Text.ToString(errorSpan);
            var suffix = diagnostic.Location.Text.ToString(suffixSpan);

            writer.Write("    ");
            writer.Write(prefix);

            writer.SetForeground(severityColor);
            writer.Write(error);
            writer.ResetColor();

            writer.Write(suffix);

            writer.WriteLine();
        }

        writer.WriteLine();
    }

    private static bool IsConsoleOut(this TextWriter writer)
    {
        if (writer == Console.Out)
        {
            return true;
        }

        if (writer is IndentedTextWriter iw && iw.InnerWriter.IsConsoleOut())
        {
            return true;
        }

        return false;
    }

    private static void SetForeground(this TextWriter writer, ConsoleColor color)
    {
        if (writer.IsConsoleOut())
        {
            Console.ForegroundColor = color;
        }
    }

    private static void ResetColor(this TextWriter writer)
    {
        if (writer.IsConsoleOut())
        {
            Console.ResetColor();
        }
    }
}

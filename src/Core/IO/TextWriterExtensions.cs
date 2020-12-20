// <copyright file="TextWriterExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.IO
{
    using System;
    using System.CodeDom.Compiler;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using GSharp.Core.CodeAnalysis;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.CodeAnalysis.Text;

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
        /// <param name="syntaxTree">The syntax tree that produced the diagnostics.</param>
        public static void WriteDiagnostics(this TextWriter writer, IEnumerable<Diagnostic> diagnostics, SyntaxTree syntaxTree)
        {
            foreach (var diagnostic in diagnostics.OrderBy(diag => diag.Span.Start).ThenBy(diag => diag.Span.Length))
            {
                var textLocation = new TextLocation(syntaxTree.Text, diagnostic.Span);

                writer.WriteLine();

                writer.SetForeground(ConsoleColor.DarkRed);
                writer.Write($"{textLocation.Text.FileName}({textLocation.StartLine + 1},{textLocation.StartCharacter + 1},{textLocation.EndLine + 1},{textLocation.EndCharacter + 1}): ");
                writer.WriteLine(diagnostic);
                writer.ResetColor();

                var lineStart = syntaxTree.Text.Lines[textLocation.StartLine];
                var lineEnd = syntaxTree.Text.Lines[textLocation.EndLine];
                var prefixSpan = TextSpan.FromBounds(lineStart.Start, diagnostic.Span.Start);
                var suffixSpan = TextSpan.FromBounds(diagnostic.Span.End, lineStart.End);

                var prefix = syntaxTree.Text.ToString(prefixSpan);
                var error = syntaxTree.Text.ToString(diagnostic.Span);
                var suffix = syntaxTree.Text.ToString(suffixSpan);

                writer.Write("    ");
                writer.Write(prefix);

                writer.SetForeground(ConsoleColor.DarkRed);
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
}

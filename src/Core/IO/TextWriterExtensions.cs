// <copyright file="TextWriterExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.IO
{
    using System;
    using System.CodeDom.Compiler;
    using System.IO;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Utility extensions to the <see cref="TextWriter"/> class.
    /// </summary>
    internal static class TextWriterExtensions
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

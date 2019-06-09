// <copyright file="TextWriterExtensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.IO
{
    using System;
    using System.CodeDom.Compiler;
    using System.IO;

    /// <summary>
    /// Utility extensions to the <see cref="TextWriter"/> class.
    /// </summary>
    internal static class TextWriterExtensions
    {
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

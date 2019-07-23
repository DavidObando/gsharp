// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Compiler
{
    using System;
    using System.Globalization;
    using System.IO;
    using System.Linq;
    using GSharp.Core.CodeAnalysis.Compilation;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.CodeAnalysis.Text;
    using static GSharp.Core.CodeAnalysis.Text.TextSpan;

    /// <summary>
    /// Entry point to gsc.
    /// </summary>
    internal class Program
    {
        /// <summary>
        /// Entry point to the GSharp compiler.
        /// </summary>
        /// <param name="args">Command line arguments.</param>
        /// <returns>Exit code.</returns>
        public static int Main(string[] args)
        {
            if (args?.Length > 0)
            {
                var arg0 = args[0];
                if (arg0.Length > 0 &&
                    arg0.EndsWith(".gs", ignoreCase: true, culture: CultureInfo.InvariantCulture) &&
                    File.Exists(args[0]))
                {
                    var success = Compile(arg0);
                    if (success)
                    {
                        return 0;
                    }
                }
                else
                {
                    Console.Error.WriteLine($"Unable to find specified file {arg0}");
                }
            }
            else
            {
                Console.Error.WriteLine($"Must specify path to a file via arguments.");
            }

            return 1;
        }

        private static bool Compile(string filePath)
        {
            string text;
            using (var reader = new StreamReader(filePath))
            {
                text = reader.ReadToEnd();
            }

            if (!string.IsNullOrWhiteSpace(text))
            {
                var syntaxTree = SyntaxTree.Parse(text);
                var compilation = new Compilation(syntaxTree);

                var result = compilation.Emit();
                if (result.Success)
                {
                    Console.WriteLine("Success.");
                    return true;
                }
                else
                {
                    foreach (var diagnostic in result.Diagnostics.OrderBy(diag => diag.Span, new TextSpanComparer()))
                    {
                        var lineIndex = syntaxTree.Text.GetLineIndex(diagnostic.Span.Start);
                        var line = syntaxTree.Text.Lines[lineIndex];
                        var lineNumber = lineIndex + 1;
                        var character = diagnostic.Span.Start - line.Start + 1;

                        Console.WriteLine();

                        Console.ForegroundColor = ConsoleColor.DarkRed;
                        Console.Write($"({lineNumber}, {character}): ");
                        Console.WriteLine(diagnostic);
                        Console.ResetColor();

                        var prefixSpan = TextSpan.FromBounds(line.Start, diagnostic.Span.Start);
                        var suffixSpan = TextSpan.FromBounds(diagnostic.Span.End, line.End);

                        var prefix = syntaxTree.Text.ToString(prefixSpan);
                        var error = syntaxTree.Text.ToString(diagnostic.Span);
                        var suffix = syntaxTree.Text.ToString(suffixSpan);

                        Console.Write("    ");
                        Console.Write(prefix);

                        Console.ForegroundColor = ConsoleColor.DarkRed;
                        Console.Write(error);
                        Console.ResetColor();

                        Console.Write(suffix);

                        Console.WriteLine();
                    }

                    Console.WriteLine("Failed.");
                }
            }
            else
            {
                Console.WriteLine();
            }

            return false;
        }
    }
}

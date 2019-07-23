// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Interpreter
{
    using System;
    using System.Globalization;
    using System.IO;

    /// <summary>
    /// Entry point to the GSharp interpreter.
    /// </summary>
    internal class Program
    {
        /// <summary>
        /// Entry point to the GSharp interpreter.
        /// </summary>
        /// <param name="args">Command line arguments.</param>
        /// <returns>Exit code.</returns>
        public static int Main(string[] args)
        {
            var repl = new GSharpRepl();
            if (args?.Length > 0)
            {
                var arg0 = args[0];
                if (arg0.Length > 0 &&
                    arg0.EndsWith(".gs", ignoreCase: true, culture: CultureInfo.InvariantCulture) &&
                    File.Exists(args[0]))
                {
                    var success = EvaluateFile(repl, arg0);
                    if (!success)
                    {
                        return 1;
                    }
                }
                else
                {
                    Console.Error.WriteLine($"Unable to find specified file {arg0}");
                    return 1;
                }
            }
            else
            {
                repl.Run();
            }

            return 0;
        }

        private static bool EvaluateFile(GSharpRepl repl, string filePath)
        {
            string text;
            using (var reader = new StreamReader(filePath))
            {
                text = reader.ReadToEnd();
            }

            if (!string.IsNullOrWhiteSpace(text))
            {
                // Hack: if the Main() func is declared, call it at the end.
                if (text.Contains("func Main()"))
                {
                    text += "\nMain()\n";
                }

                repl.EvaluateSubmission(text);
                return true;
            }
            else
            {
                Console.WriteLine("Invalid input: empty file.");
            }

            return false;
        }
    }
}

// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Compiler
{
    using System;
    using System.Collections.Generic;
    using System.Globalization;
    using System.IO;
    using System.Linq;
    using GSharp.Core.CodeAnalysis.Compilation;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;
    using GSharp.Core.IO;

    /// <summary>
    /// Entry point to gsc.
    /// </summary>
    public class Program
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
            var syntaxTree = SyntaxTree.Load(filePath);
            var compilation = new Compilation(syntaxTree);

            // var result = compilation.Emit();
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            if (result.Diagnostics.Any())
            {
                Console.Out.WriteDiagnostics(result.Diagnostics, syntaxTree);
                Console.WriteLine("Failed.");
                return false;
            }

            Console.WriteLine("Success.");
            return true;
        }
    }
}

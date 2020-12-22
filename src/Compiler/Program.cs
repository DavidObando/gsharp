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
        private const int Success = 0;
        private const int Error = 1;

        /// <summary>
        /// Entry point to the GSharp compiler.
        /// </summary>
        /// <param name="args">Command line arguments.</param>
        /// <returns>Exit code.</returns>
        public static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine($"Must specify path to a file via arguments.");
                return Error;
            }

            var paths = args;
            var syntaxTrees = new List<SyntaxTree>(paths.Length);
            foreach (var path in paths)
            {
                if (!File.Exists(path))
                {
                    Console.Error.WriteLine($"Unable to find specified file {path}");
                    return Error;
                }

                syntaxTrees.Add(SyntaxTree.Load(path));
            }

            if (!Compile(syntaxTrees.ToArray()))
            {
                Console.Error.WriteLine("Failed.");
                return Error;
            }

            Console.WriteLine("Success.");
            return Success;
        }

        private static bool Compile(params SyntaxTree[] syntaxTrees)
        {
            var compilation = new Compilation(syntaxTrees);

            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            if (result.Diagnostics.Any())
            {
                Console.Out.WriteDiagnostics(result.Diagnostics);
                return false;
            }

            return true;
        }
    }
}

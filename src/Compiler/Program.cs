// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Compiler
{
    using System.Globalization;
    using System.IO;
    using GSharp.Core.CodeAnalysis.Compilation;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Entry point to gsc.
    /// </summary>
    internal class Program
    {
        /// <summary>
        /// Entry point to the GSharp compiler.
        /// </summary>
        /// <param name="args">Command line arguments.</param>
        public static void Main(string[] args)
        {
            if (args?.Length > 0)
            {
                var arg0 = args[0];
                if (arg0.Length > 0 &&
                    arg0.EndsWith(".gs", ignoreCase: true, culture: CultureInfo.InvariantCulture) &&
                    File.Exists(args[0]))
                {
                    Compile(arg0);
                }
            }
        }

        private static void Compile(string filePath)
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

                compilation.Emit();
            }
        }
    }
}

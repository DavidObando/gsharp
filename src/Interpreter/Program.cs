// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Interpreter
{
    using System;

    /// <summary>
    /// Entry point to the GSharp interpreter.
    /// </summary>
    internal class Program
    {
        /// <summary>
        /// Entry point to the GSharp interpreter.
        /// </summary>
        /// <param name="args">Command line arguments.</param>
        public static void Main(string[] args)
        {
            var repl = new GSharpRepl();
            repl.Run();
        }
    }
}

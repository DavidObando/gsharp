// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.Cli;

/// <summary>
/// Entry point for the <c>cs2gs</c> command-line tool.
/// </summary>
internal static class Program
{
    /// <summary>
    /// Prints usage information and exits.
    /// </summary>
    /// <param name="args">The command-line arguments.</param>
    /// <returns>The process exit code.</returns>
    internal static int Main(string[] args)
    {
        Console.WriteLine("cs2gs - C# to G# migration tool");
        Console.WriteLine();
        Console.WriteLine("Usage:");
        Console.WriteLine("  cs2gs <command> [options]");
        Console.WriteLine();
        Console.WriteLine("This tool is under construction; no commands are available yet.");
        return 0;
    }
}

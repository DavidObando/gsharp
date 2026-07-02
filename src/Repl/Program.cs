// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Repl.Engine;

namespace GSharp.Repl;

/// <summary>Entry point for the G# TUI REPL.</summary>
public static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            if (Console.IsInputRedirected)
            {
                Console.Error.WriteLine("gsi requires an interactive terminal");
                return 1;
            }

            return ReplHost.Run();
        }

        var arg = args[0];
        switch (arg)
        {
            case "--help":
            case "-h":
            case "/?":
                Console.WriteLine("Usage: gsi [file.gs] [--help] [--version]");
                Console.WriteLine("  file.gs      Run the given G# script and exit.");
                Console.WriteLine("  --help, -h   Show this help and exit.");
                Console.WriteLine("  --version    Show the gsi version and exit.");
                Console.WriteLine("  (no args)    Start the interactive REPL.");
                return 0;
            case "--version":
                Console.WriteLine(ReplHost.GetVersion());
                return 0;
        }

        if (!arg.EndsWith(".gs", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine($"Unrecognized argument: {arg}");
            return 1;
        }

        if (!File.Exists(arg))
        {
            Console.Error.WriteLine($"File not found: {arg}");
            return 1;
        }

        var engine = new SessionEngine();
        var cell = engine.Evaluate(File.ReadAllText(arg));
        foreach (var d in cell.Diagnostics)
        {
            Console.Error.WriteLine($"{d.Id}: {d.Message}");
        }

        if (!cell.HasError && cell.Value is not null)
        {
            Console.WriteLine(cell.Value);
        }

        return cell.HasError ? 1 : 0;
    }
}

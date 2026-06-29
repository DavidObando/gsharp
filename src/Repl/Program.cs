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
        if (args.Length > 0 && args[0].EndsWith(".gs", StringComparison.OrdinalIgnoreCase))
        {
            if (!File.Exists(args[0]))
            {
                Console.Error.WriteLine($"File not found: {args[0]}");
                return 1;
            }

            var engine = new SessionEngine();
            var cell = engine.Evaluate(File.ReadAllText(args[0]));
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

        return ReplHost.Run();
    }
}

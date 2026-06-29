// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.IO;
using GSharp.Core.CodeAnalysis.Diagnostics;
using GSharp.Interpreter;

namespace GSharp.Repl;

/// <summary>
/// Entry point for the <c>gsi</c> GSharp interpreter REPL.
/// </summary>
public static class Program
{
    /// <summary>
    /// Entry point: launches the modern TUI when invoked bare, or evaluates a
    /// <c>.gs</c> file when one is passed as the first argument.
    /// </summary>
    /// <param name="args">Command line arguments.</param>
    /// <returns>Exit code.</returns>
    public static int Main(string[] args)
    {
        var logPath = GetLogPath(args);
        ILogger logger = logPath is not null ? new FileLogger(logPath) : NullLogger.Instance;
        try
        {
            var filteredArgs = FilterLogArg(args);
            var repl = new GSharpRepl(logger);
            if (filteredArgs.Length > 0)
            {
                var arg0 = filteredArgs[0];
                if (arg0.Length > 0 &&
                    arg0.EndsWith(".gs", ignoreCase: true, culture: CultureInfo.InvariantCulture) &&
                    File.Exists(arg0))
                {
                    logger.LogInfo($"Evaluating file: {arg0}");
                    return EvaluateFile(repl, arg0, logger) ? 0 : 1;
                }

                logger.LogWarning($"Unable to find specified file {arg0}");
                Console.WriteLine($"Unable to find specified file {arg0}");
                return 1;
            }

            logger.LogInfo("Starting REPL session");
            new TuiApp(repl).Run();
            return 0;
        }
        finally
        {
            (logger as IDisposable)?.Dispose();
        }
    }

    private static string GetLogPath(string[] args)
    {
        var logArg = Array.Find(args, a =>
            string.Equals(a, "--log", StringComparison.OrdinalIgnoreCase) ||
            a.StartsWith("--log=", StringComparison.OrdinalIgnoreCase) ||
            a.StartsWith("--log:", StringComparison.OrdinalIgnoreCase));

        if (logArg == null)
        {
            return null;
        }

        var separatorIndex = logArg.IndexOfAny(new[] { '=', ':' });
        if (separatorIndex >= 0)
        {
            var path = logArg.Substring(separatorIndex + 1).Trim();
            if (!string.IsNullOrEmpty(path))
            {
                return path;
            }
        }

        return DiagnosticLogPaths.GetDefaultFilePath("gsharp-repl-debug.log");
    }

    private static string[] FilterLogArg(string[] args)
    {
        return Array.FindAll(args, a =>
            !string.Equals(a, "--log", StringComparison.OrdinalIgnoreCase) &&
            !a.StartsWith("--log=", StringComparison.OrdinalIgnoreCase) &&
            !a.StartsWith("--log:", StringComparison.OrdinalIgnoreCase));
    }

    private static bool EvaluateFile(GSharpRepl repl, string filePath, ILogger logger)
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

        logger.LogWarning($"Invalid input: empty file {filePath}");
        Console.WriteLine("Invalid input: empty file.");
        return false;
    }
}

// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Execution;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.IO;

namespace GSharp.Repl;

/// <summary>Entry point for the G# TUI REPL.</summary>
public static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            var envChoice = EngineChoiceFromEnvironment();
            if (!IsValidEngineChoice(envChoice))
            {
                Console.Error.WriteLine(UnknownEngineMessage(envChoice));
                return 1;
            }

            return RunInteractive(new List<string>());
        }

        switch (args[0])
        {
            case "--help":
            case "-h":
            case "/?":
                Console.WriteLine("Usage: gsi [file.gs] [/r:<assembly> ...] [--engine <name>] [--help] [--version]");
                Console.WriteLine("  file.gs                Run the given G# script and exit.");
                Console.WriteLine("  /r:<file>              Reference an assembly (repeatable).");
                Console.WriteLine("  /reference:<file>      Alias for /r: (also -r: and --reference:).");
                Console.WriteLine("  --engine <name>        Interactive engine: 'emit' (the default and only");
                Console.WriteLine("                         engine; also via GSI_ENGINE). The legacy 'evaluator'");
                Console.WriteLine("                         engine has been removed.");
                Console.WriteLine("  --help, -h             Show this help and exit.");
                Console.WriteLine("  --version              Show the gsi version and exit.");
                Console.WriteLine("  (no args)              Start the interactive REPL.");
                return 0;
            case "--version":
                Console.WriteLine(ReplHost.GetVersion());
                return 0;
        }

        var references = new List<string>();
        string? scriptPath = null;
        string? engineChoice = null;
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (TryParseReferenceSwitch(arg, out var referencePath))
            {
                references.Add(referencePath);
                continue;
            }

            if (arg is "--engine" && i + 1 < args.Length)
            {
                engineChoice = args[++i];
                continue;
            }

            if (arg.StartsWith("--engine=", StringComparison.Ordinal))
            {
                engineChoice = arg.Substring("--engine=".Length);
                continue;
            }

            if (scriptPath is null && arg.EndsWith(".gs", StringComparison.OrdinalIgnoreCase))
            {
                scriptPath = arg;
                continue;
            }

            Console.Error.WriteLine($"Unrecognized argument: {arg}");
            return 1;
        }

        engineChoice ??= EngineChoiceFromEnvironment();
        if (!IsValidEngineChoice(engineChoice))
        {
            Console.Error.WriteLine(UnknownEngineMessage(engineChoice));
            return 1;
        }

        if (!ReferenceResolver.TryValidateDriverReferencePaths(references, out var referenceError))
        {
            Console.Error.WriteLine(referenceError);
            return 1;
        }

        if (scriptPath is null)
        {
            return RunInteractive(references);
        }

        if (!File.Exists(scriptPath))
        {
            Console.Error.WriteLine($"File not found: {scriptPath}");
            return 1;
        }

        return RunScript(scriptPath, references);
    }

    /// <summary>
    /// Decides whether an engine choice names a known interactive engine.
    /// ADR-0156 Phase 3c (#3176): the emitted submission-chaining engine is
    /// the only engine — the legacy tree-walking evaluator (and its
    /// <c>--engine evaluator</c> escape hatch) was deleted.
    /// </summary>
    /// <param name="engineChoice">The normalized engine choice, or <see langword="null"/> for the default.</param>
    /// <returns><see langword="true"/> when the choice is valid.</returns>
    internal static bool IsValidEngineChoice(string? engineChoice) => engineChoice is null or "emit";

    /// <summary>Builds the error line for an unknown engine choice, listing only valid values.</summary>
    /// <param name="engineChoice">The rejected engine choice.</param>
    /// <returns>The error message.</returns>
    internal static string UnknownEngineMessage(string? engineChoice)
        => $"Unknown engine '{engineChoice}'. Expected 'emit'.";

    /// <summary>Reads the <c>GSI_ENGINE</c> environment variable as a normalized engine choice.</summary>
    /// <returns>The lower-cased engine name, or <see langword="null"/> when unset or empty.</returns>
    internal static string? EngineChoiceFromEnvironment()
        => Environment.GetEnvironmentVariable("GSI_ENGINE") is { Length: > 0 } env ? env.ToLowerInvariant() : null;

    /// <summary>
    /// Starts the interactive TUI on the emitted submission-chaining
    /// <see cref="Engine.EmittedSessionEngine"/> (ADR-0156; the only
    /// interactive engine since Phase 3c deleted the tree-walking evaluator).
    /// </summary>
    private static int RunInteractive(List<string> references)
    {
        if (Console.IsInputRedirected)
        {
            Console.Error.WriteLine("gsi requires an interactive terminal");
            return 1;
        }

        var effectiveReferences = ReferenceResolver.ResolveDriverReferencePaths(references);
        return ReplHost.Run(new Engine.EmittedSessionEngine(effectiveReferences));
    }

    /// <summary>
    /// ADR-0156 Phase 1: script execution compiles with the real emitter into
    /// memory and runs in-process via <see cref="EmittedProgramHost"/> instead
    /// of the tree-walking evaluator. The driver protocol is unchanged:
    /// diagnostics render to standard error, the program's output streams
    /// straight through, and its integer result is the exit code.
    /// </summary>
    private static int RunScript(string scriptPath, List<string> references)
    {
        var tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(scriptPath), scriptPath));
        var effectiveReferences = ReferenceResolver.ResolveDriverReferencePaths(references);
        using var resolver = ReferenceResolver.WithRuntimeReferences(effectiveReferences);
        var compilation = new Compilation(resolver, tree);
        EmittedProgramResult result;
        try
        {
            result = EmittedProgramHost.Run(compilation, effectiveReferences);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            return ReportUnhandledException(ex);
        }
        if (result.Diagnostics.Any())
        {
            Console.Error.WriteDiagnostics(result.Diagnostics);
        }

        if (!result.Success)
        {
            return 1;
        }

        if (result.UnhandledException is not null)
        {
            // Mirror the CLR host's unhandled-exception protocol so gsi
            // and `dotnet exec` render crashes identically.
            Console.Error.WriteLine(EmittedProgramHost.FormatUnhandledException(result.UnhandledException));
            return EmittedProgramHost.UnhandledExceptionExitCode;
        }

        return result.ExitCode;
    }

    internal static int ReportUnhandledException(Exception ex)
    {
        DiagnosticWriter.WriteDiagnostics(Console.Error, new Diagnostic[] { Compilation.CreateInternalErrorDiagnostic(ex) });
        return 1;
    }

    internal static string GetVersion()
    {
        var info = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrEmpty(info))
        {
            return "1.0";
        }

        var plus = info.IndexOf('+');
        return plus >= 0 ? info.Substring(0, plus) : info;
    }

    /// <summary>
    /// Parses gsc-style reference switches: <c>/r:&lt;file&gt;</c> or
    /// <c>/reference:&lt;file&gt;</c> (also accepted with a leading dash).
    /// </summary>
    private static bool TryParseReferenceSwitch(string arg, [NotNullWhen(true)] out string? referencePath)
    {
        referencePath = null;
        if (arg.Length < 2 || (arg[0] != '/' && arg[0] != '-'))
        {
            return false;
        }

        var body = arg.Substring(arg.StartsWith("--", StringComparison.Ordinal) ? 2 : 1);
        var separator = body.IndexOfAny(new[] { ':', '=' });
        if (separator <= 0)
        {
            return false;
        }

        var name = body.Substring(0, separator);
        if (!name.Equals("r", StringComparison.OrdinalIgnoreCase)
            && !name.Equals("reference", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        referencePath = body.Substring(separator + 1);
        return true;
    }
}

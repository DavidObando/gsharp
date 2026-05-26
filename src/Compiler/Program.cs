// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.IO;

namespace GSharp.Compiler;

/// <summary>
/// Entry point to gsc, the GSharp command-line compiler.
/// </summary>
public class Program
{
    private const int Success = 0;
    private const int Error = 1;

    private enum OutputTarget
    {
        Exe,
        Library,
    }

    /// <summary>
    /// Entry point to the GSharp compiler.
    /// </summary>
    /// <param name="args">Command line arguments.</param>
    /// <returns>Exit code.</returns>
    public static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("Must specify path to a file via arguments.");
            return Error;
        }

        CommandLineArgs parsed;
        try
        {
            parsed = ParseCommandLine(args);
        }
        catch (CommandLineException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return Error;
        }

        if (parsed.SourceFiles.Count == 0)
        {
            Console.Error.WriteLine("Must specify at least one source file.");
            return Error;
        }

        var syntaxTrees = new List<SyntaxTree>(parsed.SourceFiles.Count);
        foreach (var path in parsed.SourceFiles)
        {
            if (!File.Exists(path))
            {
                Console.Error.WriteLine($"Unable to find specified file {path}");
                return Error;
            }

            syntaxTrees.Add(SyntaxTree.Load(path));
        }

        var references = parsed.References.Count > 0
            ? ReferenceResolver.WithReferences(parsed.References)
            : null;
        var compilation = new Compilation(references, syntaxTrees.ToArray())
        {
            ImplicitSystemImport = parsed.ImplicitSystemImport,
        };

        if (parsed.OutputPath is null)
        {
            // Legacy / no-output mode: interpret the program (back-compat).
            return Interpret(compilation, parsed);
        }

        return Emit(compilation, parsed);
    }

    private static int Interpret(Compilation compilation, CommandLineArgs args)
    {
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        if (result.Diagnostics.Any())
        {
            var effective = ApplySuppressPromote(result.Diagnostics, args);
            Console.Out.WriteDiagnostics(effective);
            if (effective.Any(d => d.IsError))
            {
                Console.Error.WriteLine("Failed.");
                return Error;
            }
        }

        Console.WriteLine("Success.");
        return Success;
    }

    private static int Emit(Compilation compilation, CommandLineArgs args)
    {
        var outputPath = args.OutputPath;
        var outputDir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(outputDir))
        {
            Directory.CreateDirectory(outputDir);
        }

        var refOutputPath = args.RefOutputPath;
        if (!string.IsNullOrEmpty(refOutputPath))
        {
            var refDir = Path.GetDirectoryName(refOutputPath);
            if (!string.IsNullOrEmpty(refDir))
            {
                Directory.CreateDirectory(refDir);
            }
        }

        EmitResult result;
        using (var peStream = File.Create(outputPath))
        using (var refStream = string.IsNullOrEmpty(refOutputPath) ? null : File.Create(refOutputPath))
        {
            result = compilation.Emit(peStream, refStream, args.AssemblyName);
        }

        // Apply /nowarn, /warnaserror filtering.
        var effectiveDiagnostics = ApplySuppressPromote(result.Diagnostics, args);

        // Always print diagnostics (errors and warnings).
        if (effectiveDiagnostics.Any())
        {
            Console.Out.WriteDiagnostics(effectiveDiagnostics);
        }

        bool hasErrors = !result.Success || effectiveDiagnostics.Any(d => d.IsError);

        if (hasErrors)
        {
            TryDelete(outputPath);
            if (!string.IsNullOrEmpty(refOutputPath))
            {
                TryDelete(refOutputPath);
            }

            Console.Error.WriteLine("Failed.");
            return Error;
        }

        if (args.Target == OutputTarget.Exe)
        {
            WriteRuntimeConfig(outputPath, args.TargetFramework);
        }

        Console.WriteLine($"Wrote {outputPath}");
        if (!string.IsNullOrEmpty(refOutputPath))
        {
            Console.WriteLine($"Wrote {refOutputPath}");
        }

        return Success;
    }

    /// <summary>
    /// Applies /nowarn, /warnaserror, /warnaserror+:, /warnaserror-: filtering to a diagnostic list.
    /// Returns the filtered/promoted set.
    /// </summary>
    private static IReadOnlyList<Diagnostic> ApplySuppressPromote(
        IEnumerable<Diagnostic> diagnostics,
        CommandLineArgs args)
    {
        var result = new List<Diagnostic>();
        foreach (var d in diagnostics)
        {
            var id = d.Id;
            var severity = d.Severity;

            // /nowarn suppresses warning-level diagnostics with the specified ID.
            if (severity == DiagnosticSeverity.Warning && args.NoWarnIds.Contains(id))
            {
                continue;
            }

            // /warnaserror+:<id> promotes specific warnings to errors.
            if (severity == DiagnosticSeverity.Warning && args.WarnAsErrorIds.Contains(id))
            {
                severity = DiagnosticSeverity.Error;
            }

            // /warnaserror (global) promotes all warnings to errors, unless /warnaserror-:<id> opts out.
            if (severity == DiagnosticSeverity.Warning && args.TreatAllWarningsAsErrors && !args.WarnNotAsErrorIds.Contains(id))
            {
                severity = DiagnosticSeverity.Error;
            }

            // If the severity changed, wrap in a new Diagnostic preserving everything else.
            if (severity != d.Severity)
            {
                result.Add(new Diagnostic(d.Location, d.Id, severity, d.Message));
            }
            else
            {
                result.Add(d);
            }
        }

        return result;
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
            // Best-effort cleanup; ignore.
        }
    }

    private static void WriteRuntimeConfig(string assemblyPath, string targetFramework)
    {
        var tfm = string.IsNullOrEmpty(targetFramework) ? "net10.0" : targetFramework;
        var (frameworkName, frameworkVersion) = ResolveFrameworkMoniker(tfm);

        var configPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        var json = $$"""
        {
          "runtimeOptions": {
            "tfm": "{{tfm}}",
            "framework": {
              "name": "{{frameworkName}}",
              "version": "{{frameworkVersion}}"
            },
            "rollForward": "LatestMinor"
          }
        }
        """;
        File.WriteAllText(configPath, json);
    }

    private static (string Name, string Version) ResolveFrameworkMoniker(string tfm)
    {
        // Crude TFM → runtime framework mapping good enough for net8/9/10.
        // The "framework.version" is the minimum shared framework version to load.
        return tfm switch
        {
            "net8.0" => ("Microsoft.NETCore.App", "8.0.0"),
            "net9.0" => ("Microsoft.NETCore.App", "9.0.0"),
            "net10.0" => ("Microsoft.NETCore.App", "10.0.0"),
            _ => ("Microsoft.NETCore.App", "10.0.0"),
        };
    }

    private static CommandLineArgs ParseCommandLine(string[] args)
    {
        var result = new CommandLineArgs();
        var expanded = ExpandResponseFiles(args);

        foreach (var raw in expanded)
        {
            if (raw.Length == 0)
            {
                continue;
            }

            if (IsSwitch(raw))
            {
                var body = raw.Substring(1);
                var colon = body.IndexOf(':');
                var name = colon < 0 ? body : body.Substring(0, colon);
                var value = colon < 0 ? string.Empty : body.Substring(colon + 1);

                switch (name.ToLowerInvariant())
                {
                    case "out":
                        result.OutputPath = value;
                        break;

                    case "refout":
                        result.RefOutputPath = value;
                        break;

                    case "assemblyname":
                        result.AssemblyName = value;
                        break;

                    case "target":
                        result.Target = value.ToLowerInvariant() switch
                        {
                            "exe" => OutputTarget.Exe,
                            "library" or "lib" or "dll" => OutputTarget.Library,
                            _ => throw new CommandLineException($"Unsupported /target value: {value}"),
                        };
                        break;

                    case "targetframework":
                    case "tfm":
                        result.TargetFramework = value;
                        break;

                    case "r":
                    case "reference":
                        // Loaded into the binder's ReferenceResolver so imports can resolve types
                        // declared in user-supplied assemblies in addition to the BCL.
                        result.References.Add(value);
                        break;

                    case "implicitimports":
                    case "implicit-imports":
                        result.ImplicitSystemImport = ParseBoolFlag(value, defaultIfEmpty: true);
                        break;

                    case "noimplicitimports":
                    case "no-implicit-imports":
                        result.ImplicitSystemImport = false;
                        break;

                    case "nowarn":
                        // /nowarn:GS0001,GS0002 or /nowarn:0001,0002
                        foreach (var id in ParseIdList(value))
                        {
                            result.NoWarnIds.Add(id);
                        }

                        break;

                    case "warnaserror":
                        // /warnaserror  → global; /warnaserror+:<ids> → promote specific ids
                        // /warnaserror-:<ids> → demote specific ids (keep as warnings even with /warnaserror)
                        if (string.IsNullOrEmpty(value))
                        {
                            result.TreatAllWarningsAsErrors = true;
                        }
                        else
                        {
                            foreach (var id in ParseIdList(value))
                            {
                                result.WarnAsErrorIds.Add(id);
                            }
                        }

                        break;

                    case "warnaserror+":
                        foreach (var id in ParseIdList(value))
                        {
                            result.WarnAsErrorIds.Add(id);
                        }

                        break;

                    case "warnaserror-":
                        foreach (var id in ParseIdList(value))
                        {
                            result.WarnNotAsErrorIds.Add(id);
                        }

                        break;

                    case "debug":
                    case "pdb":
                        // Accepted for SDK compatibility; debug info emit is Phase 2.
                        break;

                    case "?":
                    case "help":
                        result.ShowHelp = true;
                        break;

                    default:
                        // Forward-compatible: ignore unknown flags rather than failing the SDK BuildTask.
                        break;
                }
            }
            else
            {
                result.SourceFiles.Add(raw);
            }
        }

        return result;
    }

    /// <summary>
    /// Parses a comma-separated list of diagnostic IDs. Accepts both canonical
    /// form (<c>GS0001</c>) and bare numeric form (<c>0001</c> or <c>1</c>).
    /// </summary>
    private static IEnumerable<string> ParseIdList(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            yield break;
        }

        foreach (var raw in value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (raw.StartsWith("GS", StringComparison.OrdinalIgnoreCase))
            {
                yield return raw.ToUpperInvariant();
            }
            else if (int.TryParse(raw, out var num))
            {
                // Bare number: normalise to GS#### form.
                yield return $"GS{num:D4}";
            }
            else
            {
                // Unrecognised format — pass through as-is.
                yield return raw;
            }
        }
    }

    private static List<string> ExpandResponseFiles(string[] args)
    {
        var result = new List<string>(args.Length);
        foreach (var arg in args)
        {
            if (arg.Length > 0 && arg[0] == '@')
            {
                var path = arg.Substring(1);
                if (!File.Exists(path))
                {
                    throw new CommandLineException($"Response file not found: {path}");
                }

                foreach (var line in File.ReadAllLines(path, Encoding.UTF8))
                {
                    var trimmed = line.Trim();
                    if (trimmed.Length == 0 || trimmed[0] == '#')
                    {
                        continue;
                    }

                    result.Add(trimmed);
                }
            }
            else
            {
                result.Add(arg);
            }
        }

        return result;
    }

    private static bool ParseBoolFlag(string value, bool defaultIfEmpty)
    {
        if (string.IsNullOrEmpty(value))
        {
            return defaultIfEmpty;
        }

        return value.ToLowerInvariant() switch
        {
            "true" or "1" or "on" or "yes" => true,
            "false" or "0" or "off" or "no" => false,
            _ => throw new CommandLineException($"Unsupported boolean value: {value}"),
        };
    }

    private static bool IsSwitch(string arg)
    {
        if (arg.Length == 0)
        {
            return false;
        }

        if (arg[0] == '-')
        {
            return true;
        }

        if (arg[0] != '/')
        {
            return false;
        }

        // `/?` is the canonical help switch.
        if (arg == "/?")
        {
            return true;
        }

        // On Unix `/` is also the path separator. We treat `/foo:value` as a
        // switch only if the substring before the first colon contains no other
        // path separator (e.g. `/out:bar.dll` is a switch but `/tmp/x.gs` is not).
        // For `/foo` (no colon) we treat it as a switch only when the name after
        // the leading `/` contains no path separators (e.g. `/warnaserror` is a
        // switch but `/tmp/x.gs` is a file path).
        var colon = arg.IndexOf(':');
        if (colon < 0)
        {
            var nameOnly = arg.AsSpan(1);
            return nameOnly.IndexOfAny('/', '\\') < 0;
        }

        var head = arg.AsSpan(1, colon - 1);
        return head.IndexOfAny('/', '\\') < 0;
    }

    private sealed class CommandLineArgs
    {
        public List<string> SourceFiles { get; } = new();

        public List<string> References { get; } = new();

        public string OutputPath { get; set; }

        public string RefOutputPath { get; set; }

        public string AssemblyName { get; set; }

        public OutputTarget Target { get; set; } = OutputTarget.Exe;

        public string TargetFramework { get; set; }

        public bool ShowHelp { get; set; }

        public bool ImplicitSystemImport { get; set; } = true;

        /// <summary>Gets the set of diagnostic IDs to suppress (from /nowarn).</summary>
        public HashSet<string> NoWarnIds { get; } = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Gets or sets a value indicating whether all warnings should be treated as errors (from /warnaserror without IDs).</summary>
        public bool TreatAllWarningsAsErrors { get; set; }

        /// <summary>Gets the set of diagnostic IDs that should be promoted to errors (from /warnaserror+:&lt;ids&gt;).</summary>
        public HashSet<string> WarnAsErrorIds { get; } = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Gets the set of diagnostic IDs that should remain as warnings (from /warnaserror-:&lt;ids&gt;), overriding /warnaserror.</summary>
        public HashSet<string> WarnNotAsErrorIds { get; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private sealed class CommandLineException : Exception
    {
        public CommandLineException(string message)
            : base(message)
        {
        }
    }
}

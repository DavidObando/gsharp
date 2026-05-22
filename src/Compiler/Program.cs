// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
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
            return Interpret(compilation);
        }

        return Emit(compilation, parsed);
    }

    private static int Interpret(Compilation compilation)
    {
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        if (result.Diagnostics.Any())
        {
            Console.Out.WriteDiagnostics(result.Diagnostics);
            Console.Error.WriteLine("Failed.");
            return Error;
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

        EmitResult result;
        using (var peStream = File.Create(outputPath))
        {
            result = compilation.Emit(peStream, args.AssemblyName);
        }

        if (!result.Success)
        {
            try
            {
                File.Delete(outputPath);
            }
            catch (IOException)
            {
                // Best-effort cleanup; ignore.
            }

            Console.Out.WriteDiagnostics(result.Diagnostics);
            Console.Error.WriteLine("Failed.");
            return Error;
        }

        if (args.Target == OutputTarget.Exe)
        {
            WriteRuntimeConfig(outputPath, args.TargetFramework);
        }

        Console.WriteLine($"Wrote {outputPath}");
        return Success;
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
        var colon = arg.IndexOf(':');
        if (colon < 0)
        {
            return false;
        }

        var head = arg.AsSpan(1, colon - 1);
        return head.IndexOfAny('/', '\\') < 0;
    }

    private sealed class CommandLineArgs
    {
        public List<string> SourceFiles { get; } = new();

        public List<string> References { get; } = new();

        public string OutputPath { get; set; }

        public string AssemblyName { get; set; }

        public OutputTarget Target { get; set; } = OutputTarget.Exe;

        public string TargetFramework { get; set; }

        public bool ShowHelp { get; set; }

        public bool ImplicitSystemImport { get; set; } = true;
    }

    private sealed class CommandLineException : Exception
    {
        public CommandLineException(string message)
            : base(message)
        {
        }
    }
}

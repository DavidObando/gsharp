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
using GSharp.Core.CodeAnalysis.Diagnostics;
using GSharp.Core.CodeAnalysis.Emit;
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
        catch (IOException ex)
        {
            return ReportFatalIOError(ex);
        }
        catch (UnauthorizedAccessException ex)
        {
            return ReportFatalIOError(ex);
        }

        if (parsed.ShowHelp)
        {
            PrintHelp();
            return Success;
        }

        if (parsed.SourceFiles.Count == 0)
        {
            Console.Error.WriteLine("Must specify at least one source file.");
            return Error;
        }

        try
        {
            var syntaxTrees = new List<SyntaxTree>(parsed.SourceFiles.Count);
            foreach (var path in parsed.SourceFiles)
            {
                if (!File.Exists(path))
                {
                    Console.Error.WriteLine($"Unable to find specified file {path}");
                    return Error;
                }

                // Resolve to an absolute path so the document name recorded in the
                // PDB is rooted. Debuggers (vsdbg/coreclr) match on-disk breakpoints
                // against the PDB document name; a relative name leaves source
                // unresolvable, which surfaces as a phantom tab with
                // "Could not load source ...: Incorrect format of 'source' message."
                var fullPath = Path.GetFullPath(path);
                syntaxTrees.Add(SyntaxTree.Load(fullPath));
            }

            var references = parsed.References.Count > 0
                ? ReferenceResolver.WithReferences(parsed.References)
                : null;
            ILogger logger = parsed.LogPath is not null ? new FileLogger(parsed.LogPath) : NullLogger.Instance;

            try
            {
                logger.LogInfo($"Starting compiler. Sources: {parsed.SourceFiles.Count}; Output: {parsed.OutputPath ?? "<none>"}");
                ReportMissingTransitiveReferences(references, parsed);

                var compilation = new Compilation(references, syntaxTrees.ToArray())
                {
                    ImplicitSystemImport = parsed.ImplicitSystemImport,
                    IsLibrary = parsed.Target == OutputTarget.Library,
                    Logger = logger,
                    DebugInformation =
                    {
                        Format = parsed.DebugFormat,
                        PdbFilePath = parsed.PdbPath,
                        SourceLinkFilePath = parsed.SourceLinkPath,
                        Deterministic = parsed.Deterministic,
                        EmbedAllSources = parsed.EmbedAllSources,
                    },
                };

                if (parsed.OutputPath is null)
                {
                    // Legacy / no-output mode: interpret the program (back-compat).
                    return Interpret(compilation, parsed);
                }

                return Emit(compilation, parsed);
            }
            finally
            {
                (logger as IDisposable)?.Dispose();
                references?.Dispose();
            }
        }
        catch (IOException ex)
        {
            // I/O failures during source loading, directory creation, output
            // file creation, or assembly emit must surface as a structured
            // diagnostic with a non-zero exit code rather than crashing gsc.
            return ReportFatalIOError(ex);
        }
        catch (UnauthorizedAccessException ex)
        {
            // Permission-denied while reading sources or writing outputs.
            return ReportFatalIOError(ex);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            // 6.2 SilentEmitFailure invariant (outer ring): any exception
            // that escapes Compilation.Emit or the compilation setup is
            // formatted as a canonical GS9998 diagnostic line on stdout so
            // the SDK BuildTask regex matches it and the IDE error pane
            // navigates to the source file.
            return ReportUnhandledException(ex, parsed);
        }
    }

    // Tokenizes a single response-file line, splitting on whitespace while
    // respecting double-quote delimiters. Quotes are stripped from the
    // resulting tokens but the content between them (including spaces) is
    // preserved as a single token. A doubled quote ("") inside a quoted
    // section emits a literal quote character. Behavior matches what csc /
    // dotnet build accept for response files.
    internal static List<string> TokenizeResponseFileLine(string line)
    {
        var tokens = new List<string>();
        if (string.IsNullOrEmpty(line))
        {
            return tokens;
        }

        var sb = new StringBuilder();
        bool inQuotes = false;
        bool hasToken = false;

        for (int i = 0; i < line.Length; i++)
        {
            char c = line[i];

            if (c == '"')
            {
                if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                {
                    // Escaped quote inside a quoted section.
                    sb.Append('"');
                    hasToken = true;
                    i++;
                }
                else
                {
                    inQuotes = !inQuotes;
                    hasToken = true;
                }
            }
            else if (!inQuotes && char.IsWhiteSpace(c))
            {
                if (hasToken)
                {
                    tokens.Add(sb.ToString());
                    sb.Clear();
                    hasToken = false;
                }
            }
            else
            {
                sb.Append(c);
                hasToken = true;
            }
        }

        if (hasToken)
        {
            tokens.Add(sb.ToString());
        }

        return tokens;
    }

    private static int ReportFatalIOError(Exception ex)
    {
        // Emit in the csc-compatible "gsc: error GS9999: <message>" form so
        // the SDK BuildTask's diagnostic regex surfaces it as a structured
        // MSBuild error rather than an opaque process crash.
        Console.Error.WriteLine($"gsc: error GS9999: {ex.Message}");
        return Error;
    }

    private static int ReportUnhandledException(Exception ex, CommandLineArgs parsed)
    {
        // 6.2 SilentEmitFailure invariant (outer ring): format the exception
        // as a canonical diagnostic line so the SDK BuildTask regex matches.
        // Anchor at the first source file when available.
        var file = parsed?.SourceFiles?.Count > 0
            ? Path.GetFullPath(parsed.SourceFiles[0])
            : "gsc";

        var typeName = ex.GetType().Name;
        var message = $"{typeName}: {ex.Message}";

        Console.Out.WriteLine($"{file}(1,1,1,1): error GS9998: {message}");
        if (System.Environment.GetEnvironmentVariable("GS_DEBUG_STACK") != null)
        {
            Console.Out.WriteLine(ex.ToString());
        }

        return Error;
    }

    private static void ReportMissingTransitiveReferences(ReferenceResolver references, CommandLineArgs args)
    {
        if (references is null || references.MissingTransitiveReferences.IsDefaultOrEmpty)
        {
            return;
        }

        // GS9100 is advisory: the resolver already degrades gracefully (the
        // affected members are skipped), but a genuinely under-referenced
        // project benefits from naming the missing assemblies (issue #340).
        const string code = "GS9100";
        if (args.NoWarnIds.Contains(code))
        {
            return;
        }

        // Anchor the diagnostic at the first source file so the SDK BuildTask's
        // diagnostic regex surfaces it as a structured MSBuild warning.
        var file = args.SourceFiles.Count > 0
            ? Path.GetFullPath(args.SourceFiles[0])
            : "gsc";

        var names = string.Join(", ", references.MissingTransitiveReferences);
        Console.Out.WriteLine(
            $"{file}(1,1,1,1): warning {code}: One or more referenced assemblies depend on assemblies that were not supplied via /r: ({names}). " +
            "Members that reference these assemblies will be skipped. Ensure the full transitive closure of references is passed (e.g. add the missing package or project reference).");
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

        var documentationOutputPath = args.DocumentationFile;
        if (!string.IsNullOrEmpty(documentationOutputPath))
        {
            var documentationDir = Path.GetDirectoryName(documentationOutputPath);
            if (!string.IsNullOrEmpty(documentationDir))
            {
                Directory.CreateDirectory(documentationDir);
            }
        }

        // Phase 3 / ADR-0027 §7.7a: when Portable PDB is requested, open the
        // sidecar stream alongside the PE. If the caller did not supply an
        // explicit /pdb:<path>, default to "<PE>.pdb" (csc.exe convention).
        // Embedded format keeps the PDB content inside the PE — no sidecar.
        string pdbOutputPath = null;
        if (compilation.DebugInformation.Format == DebugInformationFormat.Portable)
        {
            pdbOutputPath = compilation.DebugInformation.PdbFilePath;
            if (string.IsNullOrEmpty(pdbOutputPath))
            {
                pdbOutputPath = Path.ChangeExtension(outputPath, ".pdb");
            }

            // Resolve to an absolute path so the CodeView entry recorded in
            // the PE points at a rooted sidecar location. Debuggers (vsdbg/
            // coreclr) require an absolute PDB path to bind breakpoints; a
            // relative /out:<path> would otherwise leave the sidecar
            // reference unresolvable from the debugger's working directory.
            // Mirrors the source-path fix in commit 34002ff.
            pdbOutputPath = Path.GetFullPath(pdbOutputPath);
            compilation.DebugInformation.PdbFilePath = pdbOutputPath;

            var pdbDir = Path.GetDirectoryName(pdbOutputPath);
            if (!string.IsNullOrEmpty(pdbDir))
            {
                Directory.CreateDirectory(pdbDir);
            }
        }

        EmitResult result;
        using (var peStream = File.Create(outputPath))
        using (var refStream = string.IsNullOrEmpty(refOutputPath) ? null : File.Create(refOutputPath))
        using (var pdbStream = pdbOutputPath is null ? null : File.Create(pdbOutputPath))
        using (var docStream = string.IsNullOrEmpty(documentationOutputPath) ? null : File.Create(documentationOutputPath))
        {
            result = compilation.Emit(peStream, pdbStream, refStream, docStream, args.AssemblyName, args.Version);
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

            if (!string.IsNullOrEmpty(pdbOutputPath))
            {
                TryDelete(pdbOutputPath);
            }

            if (!string.IsNullOrEmpty(documentationOutputPath))
            {
                TryDelete(documentationOutputPath);
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

    /// <summary>
    /// Prints usage/help text for the gsc command-line switches to stdout.
    /// </summary>
    private static void PrintHelp()
    {
        Console.WriteLine("""
        Usage: gsc <source-files> [options]

        Options:
          /out:<file>                   Output assembly path.
          /refout:<file>                Output reference assembly path.
          /assemblyname:<name>          Output assembly name.
          /version:<string>             Informational version stamped on the output assembly.
          /target:exe|library|lib|dll   Output type (default: exe).
          /targetframework:<tfm>        Target framework moniker (alias: /tfm:<tfm>).
          /r:<file>, /reference:<file>  Reference an assembly.
          /lib:<path>                   Accepted for csc compatibility (currently a no-op).
          /implicitimports[+|-]         Enable/disable implicit System import (alias: /implicit-imports).
          /noimplicitimports            Disable implicit System import (alias: /no-implicit-imports).
          /nowarn:<ids>                 Suppress the given diagnostic IDs (comma/semicolon separated).
          /warnaserror[+|-][:<ids>]     Treat warnings as errors, globally or for specific IDs.
          /debug[+|-][:<value>]         Emit debug info: none, portable, full, pdbonly, embedded.
          /pdb:<file>                   Sidecar PDB path.
          /doc:<file>                   XML documentation output path.
          /sourcelink:<file>            Source Link JSON file.
          /deterministic[+|-]           Enable/disable deterministic emit.
          /embed[+|-]                   Embed all primary sources in the PDB.
          /log:<file>                   Write compiler diagnostic log to file.
          /?, /help                     Show this help message.
        """);
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
                if (body.StartsWith("-", StringComparison.Ordinal))
                {
                    body = body.Substring(1);
                }

                var separator = IndexOfSwitchValueSeparator(body);
                var name = separator < 0 ? body : body.Substring(0, separator);
                var value = separator < 0 ? string.Empty : body.Substring(separator + 1);

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

                    case "version":
                        result.Version = value;
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
                        result.DebugFormat = ParseDebugValue(value);
                        result.DebugFlagSeen = true;
                        break;

                    case "debug+":
                        // /debug+ is an alias for /debug with no value: enable portable.
                        result.DebugFormat = DebugInformationFormat.Portable;
                        result.DebugFlagSeen = true;
                        break;

                    case "debug-":
                        // /debug- explicitly disables debug emit, overriding any earlier /debug.
                        result.DebugFormat = DebugInformationFormat.None;
                        result.DebugFlagSeen = true;
                        break;

                    case "pdb":
                        // /pdb:<path> sets the sidecar PDB path. Only meaningful with
                        // a Portable format — if no /debug flag has been seen yet we
                        // imply Portable here, matching csc.exe behaviour.
                        if (string.IsNullOrEmpty(value))
                        {
                            throw new CommandLineException("/pdb requires a path: /pdb:<file>.");
                        }

                        result.PdbPath = value;
                        if (!result.DebugFlagSeen)
                        {
                            result.DebugFormat = DebugInformationFormat.Portable;
                        }

                        break;

                    case "doc":
                        if (string.IsNullOrEmpty(value))
                        {
                            throw new CommandLineException("/doc requires a path: /doc:<file>.");
                        }

                        result.DocumentationFile = value;
                        break;

                    case "sourcelink":
                        if (string.IsNullOrEmpty(value))
                        {
                            throw new CommandLineException("/sourcelink requires a path: /sourcelink:<file>.");
                        }

                        result.SourceLinkPath = value;
                        break;

                    case "deterministic":
                        result.Deterministic = ParseBoolFlag(value, defaultIfEmpty: true);
                        break;

                    case "deterministic+":
                        result.Deterministic = true;
                        break;

                    case "deterministic-":
                        result.Deterministic = false;
                        break;

                    case "embed":
                        // /embed[+/-] embeds all primary sources in the PDB.
                        // Bare /embed defaults to on, matching csc semantics.
                        result.EmbedAllSources = ParseBoolFlag(value, defaultIfEmpty: true);
                        break;

                    case "embed+":
                        result.EmbedAllSources = true;
                        break;

                    case "embed-":
                        result.EmbedAllSources = false;
                        break;

                    case "log":
                        result.LogPath = string.IsNullOrWhiteSpace(value)
                            ? DiagnosticLogPaths.GetDefaultFilePath("gsharp-compiler-debug.log")
                            : value.Trim();
                        break;

                    case "lib":
                        // /lib:<path> (csc-compatible assembly search path). Accepted but
                        // currently a no-op: gsc resolves references from explicit /reference:
                        // paths only, it does not probe search directories.
                        break;

                    case "?":
                    case "help":
                        result.ShowHelp = true;
                        break;

                    default:
                        throw new CommandLineException($"Unrecognized option: {raw}. Use /? or /help for usage.");
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
    /// Parses a comma- or semicolon-separated list of diagnostic IDs. Accepts both canonical
    /// form (<c>GS0001</c>) and bare numeric form (<c>0001</c> or <c>1</c>). Semicolon is
    /// supported because MSBuild-forwarded properties such as NoWarn/WarningsAsErrors are
    /// conventionally semicolon-delimited (e.g. <c>$(NoWarn);GS0012</c>).
    /// </summary>
    private static IEnumerable<string> ParseIdList(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            yield break;
        }

        foreach (var raw in value.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
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

                    foreach (var token in TokenizeResponseFileLine(trimmed))
                    {
                        result.Add(token);
                    }
                }
            }
            else
            {
                result.Add(arg);
            }
        }

        return result;
    }

    private static DebugInformationFormat ParseDebugValue(string value)
    {
        // /debug, /debug+, /debug:portable, /debug:full → Portable
        // /debug:embedded → Embedded
        // /debug:none, /debug- → None
        if (string.IsNullOrEmpty(value))
        {
            return DebugInformationFormat.Portable;
        }

        return value.ToLowerInvariant() switch
        {
            "none" => DebugInformationFormat.None,
            "portable" or "full" or "pdbonly" => DebugInformationFormat.Portable,
            "embedded" => DebugInformationFormat.Embedded,
            _ => throw new CommandLineException($"Unsupported /debug value: {value}. Expected one of: none, portable, full, pdbonly, embedded."),
        };
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

    private static int IndexOfSwitchValueSeparator(string value)
    {
        var colon = value.IndexOf(':');
        var equals = value.IndexOf('=');
        if (colon < 0)
        {
            return equals;
        }

        if (equals < 0)
        {
            return colon;
        }

        return Math.Min(colon, equals);
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

        /// <summary>Gets or sets the requested PDB emit format (from /debug, /debug:&lt;value&gt;, /debug+/-). Defaults to None.</summary>
        public DebugInformationFormat DebugFormat { get; set; } = DebugInformationFormat.None;

        /// <summary>Gets or sets a value indicating whether a /debug, /debug+, or /debug- switch was observed on the command line. Used so that a bare /pdb:&lt;path&gt; can default the format to Portable without overriding a later /debug-.</summary>
        public bool DebugFlagSeen { get; set; }

        /// <summary>Gets or sets the explicit sidecar PDB path (from /pdb:&lt;path&gt;). Null means "default to {OutputPath}.pdb".</summary>
        public string PdbPath { get; set; }

        /// <summary>Gets or sets the XML documentation output path (from /doc:&lt;path&gt;).</summary>
        public string DocumentationFile { get; set; }

        /// <summary>Gets or sets the path to a Source Link JSON file (from /sourcelink:&lt;path&gt;).</summary>
        public string SourceLinkPath { get; set; }

        /// <summary>Gets or sets a value indicating whether the emit should be deterministic (from /deterministic, /deterministic+/-).</summary>
        public bool Deterministic { get; set; }

        /// <summary>Gets or sets a value indicating whether all primary source files are embedded in the Portable PDB (from /embed, /embed+/-).</summary>
        public bool EmbedAllSources { get; set; }

        /// <summary>Gets or sets the informational version string stamped on the output assembly (from /version:).</summary>
        public string Version { get; set; }

        /// <summary>Gets or sets the log file path (from /log:&lt;file&gt;). When non-null, a <see cref="FileLogger"/> is created and attached to the compilation.</summary>
        public string LogPath { get; set; }
    }

    private sealed class CommandLineException : Exception
    {
        public CommandLineException(string message)
            : base(message)
        {
        }
    }
}

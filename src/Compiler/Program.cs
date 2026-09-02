// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Text;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Diagnostics;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Execution;
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
            // Issue #2215: when /analyzer: paths are supplied, spawn gsgen (a
            // sibling process — ADR-0027 keeps Roslyn out of gsc) to run the
            // project's source generators and fold the generated .gs into this
            // same compilation. Zero analyzers (the overwhelmingly common case)
            // is a true no-op: no process spawned, no extra I/O.
            var allSourceFiles = parsed.SourceFiles;
            if (parsed.AnalyzerPaths.Count > 0)
            {
                if (!TryRunGsgen(parsed, out var generatedGsFiles))
                {
                    return Error;
                }

                allSourceFiles = new List<string>(parsed.SourceFiles);
                allSourceFiles.AddRange(generatedGsFiles);
            }

            var syntaxTrees = new List<SyntaxTree>(allSourceFiles.Count);
            foreach (var path in allSourceFiles)
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

            if (!ReferenceResolver.TryValidateDriverReferencePaths(parsed.References, out var referenceError))
            {
                Console.Error.WriteLine(referenceError);
                return Error;
            }

            var referencePaths = ReferenceResolver.ResolveDriverReferencePaths(parsed.References);
            var references = parsed.OutputPath is null
                ? ReferenceResolver.WithRuntimeReferences(referencePaths)
                : parsed.References.Count > 0
                    ? ReferenceResolver.WithReferences(referencePaths)
                    : ReferenceResolver.WithRuntimeReferences(referencePaths);
            ILogger logger = parsed.LogPath is not null ? new FileLogger(parsed.LogPath) : NullLogger.Instance;

            try
            {
                logger.LogInfo($"Starting compiler. Sources: {parsed.SourceFiles.Count}; Output: {parsed.OutputPath ?? "<none>"}");
                ReportMissingTransitiveReferences(references, parsed);

                var compilation = new Compilation(references, syntaxTrees.ToArray())
                {
                    ImplicitSystemImport = parsed.ImplicitSystemImport,
                    IsLibrary = parsed.Target == OutputTarget.Library,
                    Optimize = parsed.Optimize,
                    Logger = logger,

                    // Issue #1929/#1953: set as early as possible (right at
                    // construction) rather than only inside Emit(), so
                    // binding-time internal-visibility checks
                    // (ImportedAssemblySemantics.GrantsInternalAccessTo) see
                    // the correct consumer assembly name even if something
                    // forces GlobalScope/Diagnostics before Emit runs.
                    AssemblyName = parsed.AssemblyName,
                    EmbeddedResources = parsed.Resources
                        .Select(resource => (resource.Name, File.ReadAllBytes(Path.GetFullPath(resource.Path)), resource.IsPublic))
                        .ToImmutableArray(),
                    DebugInformation =
                    {
                        Format = parsed.DebugFormat,
                        PdbFilePath = parsed.PdbPath,
                        SourceLinkFilePath = parsed.SourceLinkPath,
                        Deterministic = parsed.Deterministic,
                        EmbedAllSources = parsed.EmbedAllSources,
                    },
                };

                var outputPath = parsed.OutputPath;
                if (outputPath is null)
                {
                    // Legacy / no-output mode (ADR-0156 Phase 1): compile with
                    // the real emitter into memory and execute in-process,
                    // preserving the historical evaluate-mode driver protocol.
                    return ExecuteInMemory(compilation, parsed, referencePaths);
                }

                return Emit(compilation, parsed, outputPath);
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
            // that escapes Compilation.Emit or compilation setup becomes a
            // GS9998 on stdout, using a carried source anchor when available.
            return ReportUnhandledException(ex);
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

    internal static int ReportUnhandledException(Exception ex)
    {
        DiagnosticWriter.WriteDiagnostics(Console.Out, new[] { Compilation.CreateInternalErrorDiagnostic(ex) });

        if (System.Environment.GetEnvironmentVariable("GS_DEBUG_STACK") != null)
        {
            Console.Out.WriteLine(ex.ToString());
        }

        return Error;
    }

    private static int ReportFatalIOError(Exception ex)
    {
        // Emit in the csc-compatible "gsc: error GS9997: <message>" form so
        // the SDK BuildTask's diagnostic regex surfaces it as a structured
        // MSBuild error rather than an opaque process crash.
        var descriptor = DiagnosticDescriptors.FatalCompilerIOError;
        Console.Error.WriteLine($"gsc: error {descriptor.Id}: {string.Format(descriptor.MessageFormat, ex.Message)}");
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

    // ADR-0156 Phase 1: bare gsc no longer interprets. The program is emitted
    // to memory and executed in-process by the shared host, keeping the
    // driver protocol: diagnostics to stdout, "Success."/"Failed." trailer,
    // exit code 0 on success (the program's own return value is discarded,
    // as evaluate mode always did — use /out: for a real executable).
    private static int ExecuteInMemory(
        Compilation compilation,
        CommandLineArgs args,
        IReadOnlyList<string> referencePaths)
    {
        var result = EmittedProgramHost.Run(compilation, referencePaths);
        if (result.Diagnostics.Any())
        {
            var effective = ApplySuppressPromote(result.Diagnostics, args);
            DiagnosticWriter.WriteDiagnostics(Console.Out, effective);
            if (effective.Any(d => d.IsError))
            {
                Console.Error.WriteLine("Failed.");
                return Error;
            }
        }

        if (result.UnhandledException is not null)
        {
            // Mirror the CLR host's unhandled-exception protocol so the
            // in-memory driver and `dotnet exec` render crashes identically.
            Console.Error.WriteLine(EmittedProgramHost.FormatUnhandledException(result.UnhandledException));
            return EmittedProgramHost.UnhandledExceptionExitCode;
        }

        Console.WriteLine("Success.");
        return Success;
    }

    /// <summary>
    /// ADR-0174 D1: an emitted program references <c>Gsharp.Runtime.Channels</c>
    /// whenever it constructs or operates on a channel. Under the SDK, MSBuild's
    /// copy-local puts that assembly beside the app; a direct <c>gsc /out:</c>
    /// invocation has no such step, so gsc performs the one copy itself — only
    /// when the emitted PE actually carries the AssemblyRef, so a program that
    /// never touches a channel gets nothing extra. Never overwrites a file the
    /// user already placed there.
    /// </summary>
    /// <param name="outputPath">The emitted assembly.</param>
    private static void CopyBundledRuntimeBeside(string outputPath)
    {
        try
        {
            var bundled = ReferenceResolver.FindBundledChannelsRuntimePath(AppContext.BaseDirectory);
            var outputDir = Path.GetDirectoryName(Path.GetFullPath(outputPath));
            if (bundled is null || string.IsNullOrEmpty(outputDir))
            {
                return;
            }

            var destination = Path.Combine(outputDir, Path.GetFileName(bundled));
            if (File.Exists(destination) || string.Equals(Path.GetFullPath(bundled), destination, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            using var peStream = File.OpenRead(outputPath);
            using var pe = new System.Reflection.PortableExecutable.PEReader(peStream);
            if (!pe.HasMetadata)
            {
                return;
            }

            var reader = pe.GetMetadataReader();
            var runtimeName = Path.GetFileNameWithoutExtension(bundled);
            foreach (var handle in reader.AssemblyReferences)
            {
                if (string.Equals(reader.GetString(reader.GetAssemblyReference(handle).Name), runtimeName, StringComparison.Ordinal))
                {
                    File.Copy(bundled, destination, overwrite: false);
                    return;
                }
            }
        }
        catch (IOException)
        {
            // Best effort: the program is still correct; only a direct-driver
            // run from that folder would need the assembly placed manually.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static int Emit(Compilation compilation, CommandLineArgs args, string outputPath)
    {
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
        string? pdbOutputPath = null;
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
            result = compilation.Emit(
                peStream,
                pdbStream,
                refStream,
                docStream,
                args.AssemblyName,
                args.Version,
                GetTargetFrameworkMoniker(args.TargetFramework));
        }

        // ADR-0169: run G# analyzers over the same compilation (BoundProgram
        // is cached, so this does not re-bind) and merge their diagnostics
        // into the post-hoc severity pass below.
        IEnumerable<Diagnostic> mergedDiagnostics = result.Diagnostics;
        if (args.GsAnalyzerPaths.Count > 0)
        {
            mergedDiagnostics = mergedDiagnostics.Concat(GSharp.Core.CodeAnalysis.Analyzers.GSharpAnalyzerHost.Run(compilation, args.GsAnalyzerPaths));
        }

        // Apply /gsdiag, /nowarn, /warnaserror filtering.
        var effectiveDiagnostics = ApplySuppressPromote(mergedDiagnostics, args);

        // Always print diagnostics (errors and warnings).
        if (effectiveDiagnostics.Any())
        {
            DiagnosticWriter.WriteDiagnostics(Console.Out, effectiveDiagnostics);
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

        CopyBundledRuntimeBeside(outputPath);

        Console.WriteLine($"Wrote {outputPath}");
        if (!string.IsNullOrEmpty(refOutputPath))
        {
            Console.WriteLine($"Wrote {refOutputPath}");
        }

        return Success;
    }

    private static string? GetTargetFrameworkMoniker(string? targetFramework)
    {
        if (string.IsNullOrWhiteSpace(targetFramework))
        {
            return null;
        }

        var tfm = targetFramework.Split('-')[0];
        if (tfm.StartsWith("netstandard", StringComparison.OrdinalIgnoreCase))
        {
            return ".NETStandard,Version=v" + tfm.Substring("netstandard".Length);
        }

        if (tfm.StartsWith("netcoreapp", StringComparison.OrdinalIgnoreCase))
        {
            return ".NETCoreApp,Version=v" + tfm.Substring("netcoreapp".Length);
        }

        if (!tfm.StartsWith("net", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var version = tfm.Substring(3);
        if (version.Contains('.'))
        {
            var identifier = int.TryParse(version.Split('.')[0], out var major) && major >= 5
                ? ".NETCoreApp"
                : ".NETFramework";
            return $"{identifier},Version=v{version}";
        }

        if (version.Length < 2 || !version.All(char.IsDigit))
        {
            return null;
        }

        return ".NETFramework,Version=v" + string.Join(".", version.Select(c => c.ToString()));
    }

    /// <summary>
    /// Applies /gsdiag, /nowarn, /warnaserror, /warnaserror+:, /warnaserror-: filtering to a diagnostic list.
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

            // /gsdiag:<ID>=<severity> overrides come first: "none" suppresses,
            // and an explicit severity replaces the default (which can promote
            // a Hidden diagnostic into visibility).
            if (args.DiagnosticSeverityOverrides.TryGetValue(id, out var overrideSeverity))
            {
                if (overrideSeverity is null)
                {
                    continue;
                }

                severity = overrideSeverity.Value;
            }

            // Hidden diagnostics are never surfaced on the command line unless
            // severity configuration promoted them above.
            if (severity == DiagnosticSeverity.Hidden)
            {
                continue;
            }

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

            result.Add(d.WithSeverity(severity));
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

    private static void WriteRuntimeConfig(string assemblyPath, string? targetFramework)
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

    /// <summary>
    /// Issue #2215: runs <c>gsgen</c> as a sibling process (ADR-0027 — Roslyn
    /// never links into gsc) over the caller's already-resolved <c>/analyzer:</c>
    /// paths, so any gsc invocation (SDK build, cs2gs, tests, direct compiles)
    /// gets generator output uniformly. gsgen's own diagnostics are already
    /// formatted in gsc's canonical header line, so stdout/stderr are relayed
    /// through unchanged.
    /// </summary>
    /// <param name="parsed">The parsed command line (source files, references, analyzer paths).</param>
    /// <param name="generatedGsFiles">The generated <c>.g.gs</c> paths from gsgen's manifest, on success.</param>
    /// <returns><see langword="true"/> on success; <see langword="false"/> if gsgen could not be launched or exited non-zero.</returns>
    private static bool TryRunGsgen(CommandLineArgs parsed, out List<string> generatedGsFiles)
    {
        generatedGsFiles = new List<string>();

        var gsgenPath = ResolveGsgenToolPath(parsed);
        if (!File.Exists(gsgenPath))
        {
            return ReportGsgenFailure(
                $"/analyzer was supplied but gsgen was not found at '{gsgenPath}'. Pass /gsgentool:<path> to override.");
        }

        // ponytail: a one-shot temp workspace; not cleaned up afterwards (the
        // generated .g.gs files must outlive this method to be loaded as syntax
        // trees below). Left for the OS temp reaper — gsc's invocations of gsgen
        // are rare (only with /analyzer:) so this is not worth the bookkeeping
        // of a deferred delete after the syntax trees are read into memory.
        var workDir = Directory.CreateTempSubdirectory("gsc-gsgen-").FullName;
        var outDir = Path.Combine(workDir, "out");
        var manifestPath = Path.Combine(workDir, "manifest.txt");
        var rspPath = Path.Combine(workDir, "gsgen.rsp");

        var rspLines = new List<string>();
        foreach (var gs in parsed.SourceFiles)
        {
            rspLines.Add($"/gs:\"{Path.GetFullPath(gs)}\"");
        }

        foreach (var r in parsed.References)
        {
            rspLines.Add($"/r:\"{r}\"");
        }

        foreach (var a in parsed.AnalyzerPaths)
        {
            rspLines.Add($"/analyzer:\"{a}\"");
        }

        // Issue #2223: forward non-source generator inputs (.axaml) and project
        // options (build_property.*) so file/options-driven generators run.
        foreach (var af in parsed.AdditionalFiles)
        {
            rspLines.Add($"/additionalfile:\"{af}\"");
        }

        foreach (var go in parsed.GlobalOptions)
        {
            rspLines.Add($"/globaloption:\"{go}\"");
        }

        rspLines.Add($"/out:\"{outDir}\"");
        rspLines.Add($"/manifest:\"{manifestPath}\"");
        File.WriteAllLines(rspPath, rspLines, Encoding.UTF8);

        var psi = new ProcessStartInfo("dotnet", $"\"{gsgenPath}\" @\"{rspPath}\"")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        Process? proc;
        try
        {
            proc = Process.Start(psi);
        }
        catch (Exception ex) when (ex is IOException or System.ComponentModel.Win32Exception)
        {
            return ReportGsgenFailure($"failed to launch gsgen ('{gsgenPath}'): {ex.Message}");
        }

        if (proc is null)
        {
            return ReportGsgenFailure($"failed to launch gsgen ('{gsgenPath}'): no process was started.");
        }

        using (proc)
        {
            // Read stdout/stderr concurrently with waiting for exit: reading
            // them sequentially (ReadToEnd, then ReadToEnd, then WaitForExit)
            // deadlocks if gsgen fills the other pipe's OS buffer first.
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            var stderrTask = proc.StandardError.ReadToEndAsync();

            const int gsgenTimeoutMs = 5 * 60 * 1000;
            if (!proc.WaitForExit(gsgenTimeoutMs))
            {
                try
                {
                    proc.Kill(entireProcessTree: true);
                }
                catch (InvalidOperationException)
                {
                    // Process already exited between the timeout check and Kill.
                }

                return ReportGsgenFailure(
                    $"gsgen timed out after {gsgenTimeoutMs / 1000}s while running source generators.");
            }

            var stdout = stdoutTask.GetAwaiter().GetResult();
            var stderr = stderrTask.GetAwaiter().GetResult();

            if (!string.IsNullOrEmpty(stdout))
            {
                Console.Out.Write(stdout);
            }

            if (!string.IsNullOrEmpty(stderr))
            {
                Console.Error.Write(stderr);
            }

            if (proc.ExitCode != 0)
            {
                if (string.IsNullOrWhiteSpace(stdout) && string.IsNullOrWhiteSpace(stderr))
                {
                    return ReportGsgenFailure(
                        $"gsgen exited with code {proc.ExitCode} while running source generators.");
                }

                return false;
            }
        }

        if (File.Exists(manifestPath))
        {
            foreach (var line in File.ReadAllLines(manifestPath))
            {
                var trimmed = line.Trim();
                if (trimmed.Length > 0)
                {
                    generatedGsFiles.Add(trimmed);
                }
            }
        }

        return true;
    }

    private static bool ReportGsgenFailure(string message)
    {
        var descriptor = DiagnosticDescriptors.SourceGeneratorExecutionFailure;
        Console.Error.WriteLine($"gsc: error {descriptor.Id}: {string.Format(descriptor.MessageFormat, message)}");
        return false;
    }

    /// <summary>
    /// Resolves the gsgen.dll path: the explicit /gsgentool: override when
    /// supplied, else the packaged-SDK sibling convention
    /// (tools/compiler/gsc.dll + tools/gsgen/gsgen.dll under a shared tools/).
    /// </summary>
    private static string ResolveGsgenToolPath(CommandLineArgs parsed)
    {
        if (!string.IsNullOrEmpty(parsed.GsgenToolPath))
        {
            return parsed.GsgenToolPath;
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "gsgen", "gsgen.dll"));
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
          /resource:<file>[,<name>[,public|private]]
                                        Embed a managed resource (alias: /res).
          /analyzer:<file>              Analyzer/generator assembly; runs gsgen before compiling (repeatable).
          /gsgentool:<file>             Override the resolved path to gsgen.dll (default: sibling of gsc.dll).
          /gsanalyzer:<file>            G# diagnostic analyzer assembly, run in-process after binding (repeatable, ADR-0169).
          /gsdiag:<ID>=<severity>       Per-diagnostic severity override: none, hidden, info, warning, or error (repeatable).
          /lib:<path>                   Accepted for csc compatibility (currently a no-op).
          /implicitimports[+|-]         Enable/disable implicit System import (alias: /implicit-imports).
          /noimplicitimports            Disable implicit System import (alias: /no-implicit-imports).
          /nowarn:<ids>                 Suppress the given diagnostic IDs (comma/semicolon separated).
          /warnaserror[+|-][:<ids>]     Treat warnings as errors, globally or for specific IDs.
          /optimize[+|-]                Enable/disable JIT optimization (default: enabled).
          /debug[+|-][:<value>]         Emit debug info: none, portable, full, pdbonly, embedded.
          /pdb:<file>                   Sidecar PDB path.
          /doc:<file>                   XML documentation output path.
          /sourcelink:<file>            Source Link JSON file.
          /deterministic[+|-]           Enable/disable deterministic emit.
          /embed[+|-]                   Embed all primary sources in the PDB.
          /additionalfile:<file>        Non-source generator input (e.g. Avalonia .axaml); forwarded to gsgen (repeatable).
          /globaloption:<key>=<value>   Project-wide generator option (build_property.*); forwarded to gsgen (repeatable).
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

                    case "resource":
                    case "res":
                        if (string.IsNullOrWhiteSpace(value))
                        {
                            throw new CommandLineException("/resource requires a path: /resource:<file>[,<name>].");
                        }

                        var resourceParts = value.Split(new[] { ',' }, 3);
                        var resourcePath = resourceParts[0];
                        var resourceName = resourceParts.Length < 2
                            ? Path.GetFileName(resourcePath)
                            : resourceParts[1];
                        var resourceAccess = resourceParts.Length < 3 ? "public" : resourceParts[2];
                        if (string.IsNullOrWhiteSpace(resourcePath) || string.IsNullOrWhiteSpace(resourceName))
                        {
                            throw new CommandLineException("/resource requires a non-empty path and name.");
                        }

                        if (!string.Equals(resourceAccess, "public", StringComparison.OrdinalIgnoreCase)
                            && !string.Equals(resourceAccess, "private", StringComparison.OrdinalIgnoreCase))
                        {
                            throw new CommandLineException("/resource access must be 'public' or 'private'.");
                        }

                        if (result.Resources.Any(resource => string.Equals(resource.Name, resourceName, StringComparison.Ordinal)))
                        {
                            throw new CommandLineException($"Duplicate resource name '{resourceName}'.");
                        }

                        result.Resources.Add((
                            resourcePath,
                            resourceName,
                            string.Equals(resourceAccess, "public", StringComparison.OrdinalIgnoreCase)));
                        break;

                    case "analyzer":
                        // Issue #2215: an already-resolved generator/analyzer assembly path.
                        // Repeatable, like /reference. Presence triggers a gsgen sub-process
                        // run (ADR-0145) before compilation; gsc does no analyzer discovery
                        // of its own.
                        if (string.IsNullOrEmpty(value))
                        {
                            throw new CommandLineException("/analyzer requires a path: /analyzer:<file>.");
                        }

                        result.AnalyzerPaths.Add(value);
                        break;

                    case "gsanalyzer":
                        // ADR-0169: a G# diagnostic-analyzer assembly, loaded
                        // in-process and run by GSharpAnalyzerDriver after
                        // binding. Distinct from /analyzer:, which names a
                        // Roslyn generator assembly for gsgen.
                        if (string.IsNullOrEmpty(value))
                        {
                            throw new CommandLineException("/gsanalyzer requires a path: /gsanalyzer:<file>.");
                        }

                        result.GsAnalyzerPaths.Add(value);
                        break;

                    case "gsdiag":
                        // ADR-0169: /gsdiag:GS0001=error;PROBE001=none — per-
                        // diagnostic severity overrides applied in the same
                        // post-hoc pass as /nowarn. "none" suppresses; other
                        // values replace the severity (promoting Hidden
                        // surfaces it).
                        foreach (var pair in (value ?? string.Empty).Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                        {
                            var equalsIndex = pair.IndexOf('=');
                            if (equalsIndex <= 0 || equalsIndex == pair.Length - 1)
                            {
                                throw new CommandLineException("/gsdiag requires <ID>=<none|hidden|info|warning|error> entries.");
                            }

                            var id = ParseIdList(pair[..equalsIndex]).Single();
                            var severityText = pair[(equalsIndex + 1)..];
                            DiagnosticSeverity? severity = severityText.ToLowerInvariant() switch
                            {
                                "none" => null,
                                "hidden" => DiagnosticSeverity.Hidden,
                                "info" => DiagnosticSeverity.Info,
                                "warning" => DiagnosticSeverity.Warning,
                                "error" => DiagnosticSeverity.Error,
                                _ => throw new CommandLineException($"/gsdiag: unknown severity '{severityText}'; expected none, hidden, info, warning, or error."),
                            };
                            result.DiagnosticSeverityOverrides[id] = severity;
                        }

                        break;

                    case "additionalfile":
                        // Issue #2223: a non-source input (e.g. Avalonia .axaml)
                        // forwarded verbatim to gsgen as a Roslyn AdditionalText.
                        // Repeatable. Value may carry `;key=value` metadata pairs.
                        if (string.IsNullOrWhiteSpace(value))
                        {
                            throw new CommandLineException("/additionalfile requires a path: /additionalfile:<file>.");
                        }

                        result.AdditionalFiles.Add(value);
                        break;

                    case "globaloption":
                        // Issue #2223: a project-wide generator option (build_property.*)
                        // forwarded verbatim to gsgen. Repeatable. Value is `key=value`.
                        if (string.IsNullOrWhiteSpace(value))
                        {
                            throw new CommandLineException("/globaloption requires a key=value: /globaloption:<key>=<value>.");
                        }

                        result.GlobalOptions.Add(value);
                        break;

                    case "gsgentool":
                        // Overrides the resolved path to gsgen.dll. Optional: defaults to the
                        // sibling tools/gsgen/gsgen.dll next to gsc.dll (the packaged SDK
                        // layout). Mainly useful for tests and non-packaged (cs2gs) callers.
                        result.GsgenToolPath = value;
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

                    case "optimize":
                        result.Optimize = ParseBoolFlag(value, defaultIfEmpty: true);
                        break;

                    case "optimize+":
                        result.Optimize = true;
                        break;

                    case "optimize-":
                        result.Optimize = false;
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

        /// <summary>Gets the managed resources to embed, as source path and logical name pairs.</summary>
        public List<(string Path, string Name, bool IsPublic)> Resources { get; } = new();

        /// <summary>Gets the analyzer/generator assembly paths (from /analyzer:&lt;path&gt;). Non-empty triggers a gsgen run (issue #2215).</summary>
        public List<string> AnalyzerPaths { get; } = new();

        public List<string> GsAnalyzerPaths { get; } = new();

        public Dictionary<string, DiagnosticSeverity?> DiagnosticSeverityOverrides { get; } = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Gets the raw additional-file specs (from /additionalfile:&lt;path[;key=value]&gt;) forwarded to gsgen (issue #2223).</summary>
        public List<string> AdditionalFiles { get; } = new();

        /// <summary>Gets the raw generator global options (from /globaloption:&lt;key=value&gt;) forwarded to gsgen (issue #2223).</summary>
        public List<string> GlobalOptions { get; } = new();

        /// <summary>Gets or sets an explicit override for the resolved gsgen.dll path (from /gsgentool:&lt;path&gt;).</summary>
        public string? GsgenToolPath { get; set; }

        public string? OutputPath { get; set; }

        public string? RefOutputPath { get; set; }

        public string? AssemblyName { get; set; }

        public OutputTarget Target { get; set; } = OutputTarget.Exe;

        public string? TargetFramework { get; set; }

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

        /// <summary>Gets or sets a value indicating whether emitted assemblies allow JIT optimization (from /optimize, /optimize+/-). Defaults to true.</summary>
        public bool Optimize { get; set; } = true;

        /// <summary>Gets or sets a value indicating whether a /debug, /debug+, or /debug- switch was observed on the command line. Used so that a bare /pdb:&lt;path&gt; can default the format to Portable without overriding a later /debug-.</summary>
        public bool DebugFlagSeen { get; set; }

        /// <summary>Gets or sets the explicit sidecar PDB path (from /pdb:&lt;path&gt;). Null means "default to {OutputPath}.pdb".</summary>
        public string? PdbPath { get; set; }

        /// <summary>Gets or sets the XML documentation output path (from /doc:&lt;path&gt;).</summary>
        public string? DocumentationFile { get; set; }

        /// <summary>Gets or sets the path to a Source Link JSON file (from /sourcelink:&lt;path&gt;).</summary>
        public string? SourceLinkPath { get; set; }

        /// <summary>Gets or sets a value indicating whether the emit should be deterministic (from /deterministic, /deterministic+/-).</summary>
        public bool Deterministic { get; set; }

        /// <summary>Gets or sets a value indicating whether all primary source files are embedded in the Portable PDB (from /embed, /embed+/-).</summary>
        public bool EmbedAllSources { get; set; }

        /// <summary>Gets or sets the informational version string stamped on the output assembly (from /version:).</summary>
        public string? Version { get; set; }

        /// <summary>Gets or sets the log file path (from /log:&lt;file&gt;). When non-null, a <see cref="FileLogger"/> is created and attached to the compilation.</summary>
        public string? LogPath { get; set; }
    }

    private sealed class CommandLineException : Exception
    {
        public CommandLineException(string message)
            : base(message)
        {
        }
    }
}

// <copyright file="GsgenProgram.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.GeneratorHost;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsReferenceResolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Gsgen.Cli;

/// <summary>
/// One-shot entry point for the <c>gsgen</c> tool (ADR-0145 §A/§F). The MSBuild
/// SDK invokes it as <c>dotnet gsgen.dll @file.rsp</c>; it projects the supplied
/// G# sources to a C# stub, runs the supplied Roslyn generators over it, and
/// writes the back-translated <c>.g.gs</c> parts to the output directory.
/// </summary>
/// <remarks>
/// Diagnostics are written to STDOUT in gsc's canonical header format
/// (<c>file(line,col[,endLine,endCol]): severity CODE: message</c>) so the
/// MSBuild <c>BuildTask</c> regex can relay them with structured location, code,
/// and severity. The tool never writes an unhandled stack trace: any unexpected
/// exception is converted to a single <c>GS9200</c> error line + non-zero exit.
/// </remarks>
public static class GsgenProgram
{
    /// <summary>The synthetic anchor used for diagnostics that have no source location.</summary>
    private const string SyntheticAnchor = "gsgen(1,1)";

    /// <summary>
    /// Process entry point: a thin wrapper over <see cref="Run"/> so the tool's
    /// logic stays testable in-process without spawning a child process.
    /// </summary>
    /// <param name="args">The response-file-expanded arguments.</param>
    /// <returns>The process exit code.</returns>
    public static int Main(string[] args) => Run(args, Console.Out);

    /// <summary>
    /// Runs the generator host over the parsed arguments, writing diagnostics to
    /// <paramref name="stdout"/> and returning a process exit code.
    /// </summary>
    /// <param name="args">The response-file-expanded arguments.</param>
    /// <param name="stdout">The sink for diagnostics (the process stdout in production).</param>
    /// <returns>0 on success (even with generator warnings); non-zero on a hard host failure.</returns>
    public static int Run(string[] args, TextWriter stdout)
    {
        ArgumentNullException.ThrowIfNull(stdout);

        try
        {
            // The .NET runtime does NOT auto-expand @response files for arbitrary
            // console apps, so — like gsc — gsgen expands them itself. The SDK
            // invokes `dotnet gsgen.dll @file.rsp`.
            List<string> expanded = ExpandResponseFiles(args ?? Array.Empty<string>());

            var notes = new List<string>();
            GsgenArgs parsed = GsgenArgs.Parse(expanded, notes);
            parsed.ValidateRequired();

            foreach (var note in notes)
            {
                stdout.WriteLine($"{SyntheticAnchor}: info GS9207: {note}");
            }

            // Fast path (ADR-0145 §F): with no generators AND no stray C# Compile
            // items to translate (issue #2214) there is nothing to produce. Emit
            // an empty manifest (so MSBuild's orphan cleanup still has a fresh,
            // empty owned-file list) and exit immediately.
            if (parsed.AnalyzerPaths.Count == 0 && parsed.CsFiles.Count == 0)
            {
                WriteManifest(parsed.ManifestPath, Array.Empty<string>());
                return 0;
            }

            parsed.ValidateGsFilesExist();
            parsed.ValidateCsFilesExist();
            parsed.ValidateAdditionalFilesExist();

            var generatedGsFiles = new List<(string HintName, string GSharpSource)>();
            GeneratorHostResult result = null;

            if (parsed.AnalyzerPaths.Count > 0)
            {
                result = RunHost(parsed);
                generatedGsFiles.AddRange(result.GeneratedGsFiles);
            }

            if (parsed.CsFiles.Count > 0)
            {
                generatedGsFiles.AddRange(TranslateForeignCSharp(parsed));
            }

            IReadOnlyList<string> written = WriteGeneratedFiles(parsed.OutDir, generatedGsFiles);
            CleanOrphans(parsed.OutDir, written);
            WriteManifest(parsed.ManifestPath, written);

            if (result != null)
            {
                EmitDiagnostics(stdout, result);
            }

            return 0;
        }
        catch (Exception ex)
        {
            // Never leak a raw stack trace to MSBuild: collapse any failure into a
            // single structured GS9200 line so the BuildTask regex can relay it.
            stdout.WriteLine($"{SyntheticAnchor}: error GS9200: {Flatten(ex)}");
            return 1;
        }
    }

    private static GeneratorHostResult RunHost(GsgenArgs parsed)
    {
        var syntaxTrees = parsed.GsFiles
            .Select(GsSyntaxTree.Load)
            .ToArray();

        // (a) the G# reference resolver the Compilation binds imports against.
        GsReferenceResolver resolver = GsReferenceResolver.WithReferences(parsed.References);

        IReadOnlyList<MetadataReference> metadataRefs = BuildMetadataReferences(parsed.References);

        var compilation = new Compilation(resolver, syntaxTrees);

        // Issue #2223: forward the project's non-source inputs (.axaml) and the
        // MSBuild options file/options-driven generators (e.g. Avalonia) read.
        IReadOnlyList<AdditionalText> additionalTexts = parsed.AdditionalFiles
            .Select(spec => (AdditionalText)new HostAdditionalText(spec.Path, spec.Metadata))
            .ToList();

        var optionsProvider = new HostAnalyzerConfigOptionsProvider(parsed.GlobalOptions);

        return GeneratorHostRunner.RunFromAnalyzerPaths(
            compilation, metadataRefs, parsed.AnalyzerPaths, additionalTexts, optionsProvider);
    }

    /// <summary>
    /// The metadata references the host's C# stub/generated/foreign code binds
    /// against. Filter to files that exist so <c>CreateFromFile</c> never throws.
    /// Issue #2215: augmented with the host's own trusted-platform (BCL)
    /// assemblies as a fallback for any name the caller didn't enumerate — the
    /// same "explicit wins, host BCL fills gaps" policy <see cref="GsReferenceResolver.WithReferences"/>
    /// already applies for G# symbol binding. Without this, a caller that omits
    /// <c>/r:</c> (e.g. gsc's minimal <c>/analyzer:</c> path) would hand the C#
    /// stub compilation zero references, leaving even <c>System.Obsolete</c>
    /// unresolved and every attribute-driven generator predicate a silent no-op.
    /// </summary>
    private static IReadOnlyList<MetadataReference> BuildMetadataReferences(IReadOnlyList<string> referencePaths)
    {
        var explicitPaths = referencePaths.Where(File.Exists).ToArray();
        var seenFileNames = new HashSet<string>(
            explicitPaths.Select(Path.GetFileName), StringComparer.OrdinalIgnoreCase);

        var all = new List<string>(explicitPaths);
        foreach (var host in GsReferenceResolver.HostTrustedPlatformAssemblyPaths())
        {
            if (seenFileNames.Add(Path.GetFileName(host)))
            {
                all.Add(host);
            }
        }

        return all.Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
    }

    /// <summary>
    /// Issue #2214 / ADR-0145 extension: translates each "foreign" <c>.cs</c>
    /// file directly to G# using the same translation core gsgen already uses
    /// for generator output (<see cref="GeneratedDocTranslator"/>) — no C# stub
    /// or generator run is involved, the file itself is the "generated"
    /// document. This is what makes a stray <c>Compile</c> item (e.g.
    /// Nerdbank.GitVersioning's <c>ThisAssembly.cs</c>) consumable by gsc: it is
    /// translated once here and folded into <c>@(Compile)</c> as an ordinary
    /// <c>.g.gs</c> by the SDK's existing manifest-fold target.
    /// </summary>
    private static IReadOnlyList<(string HintName, string GSharpSource)> TranslateForeignCSharp(GsgenArgs parsed)
    {
        IReadOnlyList<MetadataReference> metadataRefs = BuildMetadataReferences(parsed.References);

        var docs = parsed.CsFiles
            .Select(path => new GeneratedCsDocument(Path.GetFileName(path), SourceText.From(File.ReadAllText(path))))
            .ToList();

        // No C# stub is needed — the foreign file(s) are bound together against
        // the project's own reference closure, exactly like generator output.
        IReadOnlyList<TranslatedGsDocument> translated =
            GeneratedDocTranslator.Translate(string.Empty, docs, metadataRefs);

        return translated
            .OrderBy(t => t.HintName, StringComparer.Ordinal)
            .Select(t => (t.HintName, t.GSharpSource))
            .ToList();
    }

    /// <summary>
    /// Writes each back-translated part to <c>&lt;out&gt;/&lt;sanitized&gt;.g.gs</c>,
    /// creating the output directory and only touching a file when its content
    /// changes (MSBuild incrementality). Returns the full set of owned file paths
    /// this run produced (whether freshly written or already up to date).
    /// </summary>
    private static IReadOnlyList<string> WriteGeneratedFiles(
        string outDir,
        IReadOnlyList<(string HintName, string GSharpSource)> files)
    {
        Directory.CreateDirectory(outDir);

        var written = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (hintName, source) in files)
        {
            var fileName = ToOutputFileName(hintName);

            // Disambiguate the rare case where two hint names sanitize to the
            // same file so no generated part is silently dropped.
            var candidate = fileName;
            var suffix = 1;
            while (!seen.Add(candidate))
            {
                candidate = Path.GetFileNameWithoutExtension(fileName) + "_" + suffix + ".g.gs";
                suffix++;
            }

            var path = Path.Combine(outDir, candidate);
            WriteIfDifferent(path, source);
            written.Add(path);
        }

        return written;
    }

    /// <summary>
    /// Deletes any gsgen-owned <c>*.g.gs</c> file under <paramref name="outDir"/>
    /// that was not regenerated this run (a stale part from a prior generator
    /// shape). Only files directly under the output directory matching the
    /// gsgen-owned <c>*.g.gs</c> pattern are ever removed — never user files.
    /// </summary>
    private static void CleanOrphans(string outDir, IReadOnlyList<string> written)
    {
        if (!Directory.Exists(outDir))
        {
            return;
        }

        var keep = new HashSet<string>(
            written.Select(Path.GetFullPath),
            StringComparer.OrdinalIgnoreCase);

        foreach (var existing in Directory.EnumerateFiles(outDir, "*.g.gs", SearchOption.TopDirectoryOnly))
        {
            if (!keep.Contains(Path.GetFullPath(existing)))
            {
                try
                {
                    File.Delete(existing);
                }
                catch (IOException)
                {
                    // A locked orphan is not fatal; the next clean build removes it.
                }
                catch (UnauthorizedAccessException)
                {
                }
            }
        }
    }

    private static void WriteManifest(string manifestPath, IReadOnlyList<string> written)
    {
        if (string.IsNullOrWhiteSpace(manifestPath))
        {
            return;
        }

        var dir = Path.GetDirectoryName(Path.GetFullPath(manifestPath));
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var content = written.Count == 0
            ? string.Empty
            : string.Join(Environment.NewLine, written) + Environment.NewLine;

        WriteIfDifferent(manifestPath, content);
    }

    private static void WriteIfDifferent(string path, string content)
    {
        if (File.Exists(path) && string.Equals(File.ReadAllText(path), content, StringComparison.Ordinal))
        {
            return;
        }

        File.WriteAllText(path, content);
    }

    /// <summary>
    /// Turns a generator-assigned hint name (e.g. <c>Foo.g.cs</c> or a nested
    /// <c>Ns/Foo.cs</c>) into a safe file name ending in <c>.g.gs</c>.
    /// </summary>
    private static string ToOutputFileName(string hintName)
    {
        var name = hintName ?? "generated";

        // Hint names may carry directory separators; flatten them so everything
        // lands directly under the output directory.
        name = name.Replace('\\', '_').Replace('/', '_');

        foreach (var invalid in Path.GetInvalidFileNameChars())
        {
            name = name.Replace(invalid, '_');
        }

        // Strip a trailing generator extension so we do not end up with e.g.
        // "Foo.g.cs.g.gs"; the canonical gsgen suffix is re-appended below.
        foreach (var ext in new[] { ".g.gs", ".g.cs", ".gs", ".cs" })
        {
            if (name.EndsWith(ext, StringComparison.OrdinalIgnoreCase))
            {
                name = name.Substring(0, name.Length - ext.Length);
                break;
            }
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            name = "generated";
        }

        return name + ".g.gs";
    }

    /// <summary>
    /// Emits generator diagnostics (GS9203 for crashes, GS9204 for the stub's
    /// unspellable-type fallbacks) plus the generators' own reported diagnostics,
    /// all in gsc's canonical header format so the SDK's BuildTask relays them.
    /// </summary>
    private static void EmitDiagnostics(TextWriter stdout, GeneratorHostResult result)
    {
        foreach (var diagnostic in result.GeneratorDiagnostics)
        {
            stdout.WriteLine(FormatRoslynDiagnostic(diagnostic));
        }

        foreach (var failure in result.Failures)
        {
            stdout.WriteLine(
                $"{SyntheticAnchor}: warning GS9203: generator '{failure.Source}' failed: {Flatten(failure.Exception)}");
        }

        foreach (var fallback in result.StubFallbacks)
        {
            stdout.WriteLine($"{SyntheticAnchor}: info GS9204: {fallback}");
        }
    }

    /// <summary>
    /// Renders a Roslyn <see cref="Diagnostic"/> in gsc's canonical header line.
    /// Diagnostics carry locations into the synthetic C# stub, so we surface the
    /// stub's file/line as-is (better than nothing) and fall back to the synthetic
    /// anchor when the diagnostic has no location.
    /// </summary>
    private static string FormatRoslynDiagnostic(Diagnostic diagnostic)
    {
        var severity = diagnostic.Severity switch
        {
            DiagnosticSeverity.Error => "error",
            DiagnosticSeverity.Warning => "warning",
            _ => "info",
        };

        var message = diagnostic.GetMessage().Replace("\r", " ").Replace("\n", " ");

        if (diagnostic.Location.Kind == LocationKind.None)
        {
            return $"{SyntheticAnchor}: {severity} {diagnostic.Id}: {message}";
        }

        var span = diagnostic.Location.GetLineSpan();
        var file = string.IsNullOrEmpty(span.Path) ? "gsgen" : span.Path;
        var line = span.StartLinePosition.Line + 1;
        var col = span.StartLinePosition.Character + 1;
        var endLine = span.EndLinePosition.Line + 1;
        var endCol = span.EndLinePosition.Character + 1;

        return $"{file}({line},{col},{endLine},{endCol}): {severity} {diagnostic.Id}: {message}";
    }

    private static string Flatten(Exception ex)
    {
        var message = (ex?.Message ?? "unknown error").Replace("\r", " ").Replace("\n", " ");
        return message;
    }

    /// <summary>
    /// Expands any <c>@file</c> arguments in place by reading the referenced
    /// response file line by line (skipping blank lines and <c>#</c> comments)
    /// and tokenizing each line on unquoted whitespace. Non-<c>@</c> arguments
    /// pass through unchanged. Mirrors gsc's response-file handling so the SDK
    /// can invoke both tools identically.
    /// </summary>
    private static List<string> ExpandResponseFiles(IReadOnlyList<string> args)
    {
        var result = new List<string>(args.Count);
        foreach (var arg in args)
        {
            if (arg is { Length: > 0 } && arg[0] == '@')
            {
                var path = arg.Substring(1);
                if (!File.Exists(path))
                {
                    throw new FileNotFoundException($"Response file not found: '{path}'.", path);
                }

                foreach (var line in File.ReadAllLines(path))
                {
                    var trimmed = line.Trim();
                    if (trimmed.Length == 0 || trimmed[0] == '#')
                    {
                        continue;
                    }

                    result.AddRange(TokenizeResponseFileLine(trimmed));
                }
            }
            else
            {
                result.Add(arg);
            }
        }

        return result;
    }

    /// <summary>
    /// Splits a single response-file line into tokens on unquoted whitespace,
    /// honoring double-quoted spans (so reference paths under directories with
    /// spaces survive) and doubled <c>""</c> as an escaped quote.
    /// </summary>
    private static IEnumerable<string> TokenizeResponseFileLine(string line)
    {
        var tokens = new List<string>();
        if (string.IsNullOrEmpty(line))
        {
            return tokens;
        }

        var sb = new System.Text.StringBuilder();
        bool inQuotes = false;
        bool hasToken = false;

        for (int i = 0; i < line.Length; i++)
        {
            char c = line[i];
            if (c == '"')
            {
                if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                {
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
}

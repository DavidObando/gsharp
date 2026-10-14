// <copyright file="GsgenProgram.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Gsgen.Cli

import System
import System.Collections.Generic
import System.IO
import System.Linq
import GSharp.GeneratorHost
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Text
import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsReferenceResolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System.Text

/// One-shot entry point for the `gsgen` tool (ADR-0145 §A/§F). The MSBuild
/// SDK invokes it as `dotnet gsgen.dll @file.rsp`; it projects the supplied
/// G# sources to a C# stub, runs the supplied Roslyn generators over it, and
/// writes the back-translated `.g.gs` parts to the output directory.
/// @remarks Diagnostics are written to STDOUT in gsc's canonical header format
/// (`file(line,col[,endLine,endCol]): severity CODE: message`) so the
/// MSBuild `BuildTask` regex can relay them with structured location, code,
/// and severity. The tool never writes an unhandled stack trace: any unexpected
/// exception is converted to a single `GS9200` error line + non-zero exit.
shared class GsgenProgram {
    /// Process entry point: a thin wrapper over (cref:Run) so the tool's
    /// logic stays testable in-process without spawning a child process.
    /// @param args The response-file-expanded arguments.
    /// @returns The process exit code.
    func Main(args[]string) int32 -> Run(args, Console.Out)

    /// Runs the generator host over the parsed arguments, writing diagnostics to
    /// [`stdout`](paramref) and returning a process exit code.
    /// @param args The response-file-expanded arguments.
    /// @param stdout The sink for diagnostics (the process stdout in production).
    /// @returns 0 on success (even with generator warnings); non-zero on a hard host failure.
    func Run(args[]string, stdout TextWriter) int32 {
        ArgumentNullException.ThrowIfNull(stdout, paramName: "stdout")
        try {
            // The .NET runtime does NOT auto-expand @response files for arbitrary
            // console apps, so — like gsc — gsgen expands them itself. The SDK
            // invokes `dotnet gsgen.dll @file.rsp`.
            let expanded = ExpandResponseFiles(args ?? Array.Empty[string]())
            let notes = List[string]()
            let parsed = GsgenArgs.Parse(expanded, notes)
            parsed.ValidateRequired()
            for note in notes {
                stdout.WriteLine("${GsgenDiagnostics.SyntheticAnchor}: info GS9207: $note")
            }
            // Fast path (ADR-0145 §F): with no generators AND no stray C# Compile
            // items to translate (issue #2214) there is nothing to produce. Emit
            // an empty manifest (so MSBuild's orphan cleanup still has a fresh,
            // empty owned-file list) and exit immediately.
            if parsed.AnalyzerPaths.Count == 0 && parsed.CsFiles.Count == 0 {
                WriteManifest(parsed.ManifestPath, Array.Empty[string]())
                return 0
            }
            parsed.ValidateGsFilesExist()
            parsed.ValidateCsFilesExist()
            parsed.ValidateAdditionalFilesExist()
            let generatedGsFiles = List[(HintName string, GSharpSource string)]()
            var result GeneratorHostResult? = nil
            if parsed.AnalyzerPaths.Count > 0 {
                result = RunHost(parsed)
                generatedGsFiles.AddRange(result.GeneratedGsFiles)
            }
            if parsed.CsFiles.Count > 0 {
                generatedGsFiles.AddRange(TranslateForeignCSharp(parsed))
            }
            let written = WriteGeneratedFiles(parsed.OutDir, generatedGsFiles)
            CleanOrphans(parsed.OutDir, written)
            WriteManifest(parsed.ManifestPath, written)
            if result != nil {
                EmitDiagnostics(stdout, result)
            }
            return 0
        } catch (ex Exception) {
            // Never leak a raw stack trace to MSBuild: collapse any failure into a
            // single structured GS9200 line so the BuildTask regex can relay it.
            stdout.WriteLine("${GsgenDiagnostics.SyntheticAnchor}: error GS9200: ${Flatten(ex)}")
            return 1
        }
    }

    private func RunHost(parsed GsgenArgs) GeneratorHostResult {
        let syntaxTrees = parsed.GsFiles.Select(GsSyntaxTree.Load).ToArray()
        // (a) the G# reference resolver the Compilation binds imports against.
        let resolver = GsReferenceResolver.WithReferences(parsed.References)
        let metadataRefs = BuildMetadataReferences(parsed.References)
        let compilation = Compilation(resolver, syntaxTrees)
        // Issue #2223: forward the project's non-source inputs (.axaml) and the
        // MSBuild options file/options-driven generators (e.g. Avalonia) read.
        let additionalTexts IReadOnlyList[AdditionalText] = parsed
            .AdditionalFiles
            .Select((spec AdditionalFileSpec) -> cast[AdditionalText](HostAdditionalText(spec.Path, spec.Metadata)))
            .ToList()
        let optionsProvider = HostAnalyzerConfigOptionsProvider(parsed.GlobalOptions)
        return GeneratorHostRunner.RunFromAnalyzerPaths(
            compilation,
            metadataRefs,
            parsed.AnalyzerPaths,
            additionalTexts,
            optionsProvider
        )
    }

    /// The metadata references the host's C# stub/generated/foreign code binds
    /// against. Filter to files that exist so `CreateFromFile` never throws.
    /// Issue #2215: augmented with the host's own trusted-platform (BCL)
    /// assemblies as a fallback for any name the caller didn't enumerate — the
    /// same "explicit wins, host BCL fills gaps" policy (cref:GsReferenceResolver.WithReferences)
    /// already applies for G# symbol binding. Without this, a caller that omits
    /// `/r:` (e.g. gsc's minimal `/analyzer:` path) would hand the C#
    /// stub compilation zero references, leaving even `System.Obsolete`
    /// unresolved and every attribute-driven generator predicate a silent no-op.
    /// @remarks The host fallback is applied ONLY when [`referencePaths`](paramref)
    /// resolves to zero usable files. A caller that already supplies its own
    /// reference closure (e.g. the SDK's `GsgenTask`, forwarding
    /// `@(ReferencePathWithRefAssemblies)` — the project's real,
    /// transitively-closed REF-assembly set) must not have the host's OWN
    /// runtime IMPL assemblies (e.g. `System.Private.CoreLib.dll` from
    /// `shared/Microsoft.NETCore.App/<ver>/`) unioned in alongside
    /// it: mixing a framework's REF assembly (from the targeting pack) with
    /// its IMPL assembly (from the shared runtime) for the same well-known
    /// types is a classic Roslyn "type exists in both ... and ..." (CS0433)
    /// trap, and the resulting ambiguity makes even `System.String`/
    /// `System.Object`/`System.Void` resolve as (cref:SpecialType.None)
    /// (CS0518 "predefined type ... is not defined"), which degraded EVERY
    /// primitive/string-typed generator-produced member (e.g. CommunityToolkit
    /// MVVM's `[ObservableProperty]` backing fields) to the G#
    /// `object` placeholder even though reference/user types resolved
    /// fine (they never go through `SpecialType`).
    private func BuildMetadataReferences(referencePaths IReadOnlyList[string]) IReadOnlyList[MetadataReference] {
        let explicitPaths = referencePaths.Where(File.Exists).ToArray()
        if explicitPaths.Length > 0 {
            return explicitPaths.Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
        }
        let seenFileNames = HashSet[string](StringComparer.OrdinalIgnoreCase)
        let all = List[string]()
        for host in GsReferenceResolver.HostTrustedPlatformAssemblyPaths() {
            if seenFileNames.Add(Path.GetFileName(host)) {
                all.Add(host)
            }
        }
        return all.Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p))).ToList()
    }

    /// Issue #2214 / ADR-0145 extension: translates each "foreign" `.cs`
    /// file directly to G# using the same translation core gsgen already uses
    /// for generator output ((cref:GeneratedDocTranslator)) — no C# stub
    /// or generator run is involved, the file itself is the "generated"
    /// document. This is what makes a stray `Compile` item (e.g.
    /// Nerdbank.GitVersioning's `ThisAssembly.cs`) consumable by gsc: it is
    /// translated once here and folded into `@(Compile)` as an ordinary
    /// `.g.gs` by the SDK's existing manifest-fold target.
    private func TranslateForeignCSharp(parsed GsgenArgs) IReadOnlyList[(HintName string, GSharpSource string)] {
        let metadataRefs = BuildMetadataReferences(parsed.References)
        let docs = parsed
            .CsFiles
            .Select(
            (path string) -> GeneratedCsDocument(
                Path.GetFileName(path),
                Microsoft.CodeAnalysis.Text.SourceText.From(File.ReadAllText(path))
            )
        )
            .ToList()
        // No C# stub is needed — the foreign file(s) are bound together against
        // the project's own reference closure, exactly like generator output.
        let translated = GeneratedDocTranslator.Translate(string.Empty, docs, metadataRefs)
        return translated
            .OrderBy((t TranslatedGsDocument) -> t.HintName, StringComparer.Ordinal)
            .Select((t TranslatedGsDocument) -> (t.HintName, t.GSharpSource))
            .ToList()
    }

    /// Writes each back-translated part to `<out>/<sanitized>.g.gs`,
    /// creating the output directory and only touching a file when its content
    /// changes (MSBuild incrementality). Returns the full set of owned file paths
    /// this run produced (whether freshly written or already up to date).
    private func WriteGeneratedFiles(
        outDir string,
        files IReadOnlyList[(HintName string, GSharpSource string)]
    ) IReadOnlyList[string] {
        Directory.CreateDirectory(outDir)
        let written = List[string]()
        let seen = HashSet[string](StringComparer.OrdinalIgnoreCase)
        for (hintName, source) in files {
            let fileName = ToOutputFileName(hintName)
            // Disambiguate the rare case where two hint names sanitize to the
            // same file so no generated part is silently dropped.
            var candidate = fileName
            var suffix = 1
            while !seen.Add(candidate) {
                candidate = Path.GetFileNameWithoutExtension(fileName) + "_" + suffix.ToString() + ".g.gs"
                suffix++
            }
            let path = Path.Combine(outDir, candidate)
            WriteIfDifferent(path, source)
            written.Add(path)
        }
        return written
    }

    /// Deletes any gsgen-owned `*.g.gs` file under [`outDir`](paramref)
    /// that was not regenerated this run (a stale part from a prior generator
    /// shape). Only files directly under the output directory matching the
    /// gsgen-owned `*.g.gs` pattern are ever removed — never user files.
    private func CleanOrphans(outDir string, written IReadOnlyList[string]) {
        if !Directory.Exists(outDir) {
            return
        }
        let keep = HashSet[string](written.Select(Path.GetFullPath), StringComparer.OrdinalIgnoreCase)
        for existing in Directory.EnumerateFiles(outDir, "*.g.gs", SearchOption.TopDirectoryOnly) {
            if !keep.Contains(Path.GetFullPath(existing)) {
                try {
                    File.Delete(existing)
                } catch (IOException) {
                    // A locked orphan is not fatal; the next clean build removes it.

                } catch (UnauthorizedAccessException) { }
            }
        }
    }

    private func WriteManifest(manifestPath string, written IReadOnlyList[string]) {
        if string.IsNullOrWhiteSpace(manifestPath) {
            return
        }
        let dir string? = Path.GetDirectoryName(Path.GetFullPath(manifestPath))
        if !string.IsNullOrEmpty(dir) {
            Directory.CreateDirectory(dir)
        }
        let content = if written.Count == 0 {
            string.Empty
        } else {
            string.Join(Environment.NewLine, written) + Environment.NewLine
        }
        WriteIfDifferent(manifestPath, content)
    }

    private func WriteIfDifferent(path string, content string) {
        if File.Exists(path) && string.Equals(File.ReadAllText(path), content, StringComparison.Ordinal) {
            return
        }
        File.WriteAllText(path, content)
    }

    /// Turns a generator-assigned hint name (e.g. `Foo.g.cs` or a nested
    /// `Ns/Foo.cs`) into a safe file name ending in `.g.gs`.
    private func ToOutputFileName(hintName string) string {
        var name = hintName ?? "generated"
        // Hint names may carry directory separators; flatten them so everything
        // lands directly under the output directory.
        name = name.Replace('\\', '_').Replace('/', '_')
        for invalid in Path.GetInvalidFileNameChars() {
            name = name.Replace(invalid, '_')
        }
        // Strip a trailing generator extension so we do not end up with e.g.
        // "Foo.g.cs.g.gs"; the canonical gsgen suffix is re-appended below.
        for ext in[]string{".g.gs", ".g.cs", ".gs", ".cs"} {
            if name.EndsWith(ext, StringComparison.OrdinalIgnoreCase) {
                name = name.Substring(0, name.Length - ext.Length)
                break
            }
        }
        if string.IsNullOrWhiteSpace(name) {
            name = "generated"
        }
        return name + ".g.gs"
    }

    /// Emits generator diagnostics (GS9203 for crashes, GS9204 for the stub's
    /// unspellable-type fallbacks) plus the generators' own reported diagnostics,
    /// all in gsc's canonical header format so the SDK's BuildTask relays them.
    private func EmitDiagnostics(stdout TextWriter, result GeneratorHostResult) {
        for diagnostic in result.GeneratorDiagnostics {
            stdout.WriteLine(FormatRoslynDiagnostic(diagnostic))
        }
        for failure in result.Failures {
            stdout.WriteLine(
                "${GsgenDiagnostics.SyntheticAnchor}: warning GS9203: generator '${failure.Source}' failed: ${Flatten(failure.Exception)}"
            )
        }
        for fallback in result.StubFallbacks {
            stdout.WriteLine("${GsgenDiagnostics.SyntheticAnchor}: info GS9204: $fallback")
        }
        // ADR-0192 follow-on 2: a generated implementing part whose header
        // could not be copied from the user's declaring part (GS9208). An
        // error, anchored at the declaring part, so the build fails there.
        for diagnostic in result.HostDiagnostics {
            stdout.WriteLine(FormatHostDiagnostic(diagnostic))
        }
    }

    private func FormatHostDiagnostic(diagnostic GeneratorHostDiagnostic) string {
        let message = diagnostic.Message.Replace("\r", " ").Replace("\n", " ")
        var location = diagnostic.Location
        if string.IsNullOrEmpty(location.FileName) {
            return "${GsgenDiagnostics.SyntheticAnchor}: error ${diagnostic.Id}: $message"
        }
        return "${location.FileName}(${location.StartLine + 1},${location.StartCharacter + 1}," +
            "${location.EndLine + 1},${location.EndCharacter + 1}): error ${diagnostic.Id}: $message"
    }

    /// Renders a Roslyn (cref:Diagnostic) in gsc's canonical header line.
    /// Diagnostics carry locations into the synthetic C# stub, so we surface the
    /// stub's file/line as-is (better than nothing) and fall back to the synthetic
    /// anchor when the diagnostic has no location.
    private func FormatRoslynDiagnostic(diagnostic Diagnostic) string {
        let severity = switch diagnostic.Severity {
            case DiagnosticSeverity.Error: "error"
            case DiagnosticSeverity.Warning: "warning"
            default: "info"
        }
        let message = diagnostic.GetMessage().Replace("\r", " ").Replace("\n", " ")
        if diagnostic.Location.Kind == LocationKind.None {
            return "${GsgenDiagnostics.SyntheticAnchor}: $severity ${diagnostic.Id}: $message"
        }
        let span = diagnostic.Location.GetLineSpan()
        let file = if string.IsNullOrEmpty(span.Path) {
            "gsgen"
        } else {
            span.Path
        }
        let line = span.StartLinePosition.Line + 1
        let col = span.StartLinePosition.Character + 1
        let endLine = span.EndLinePosition.Line + 1
        let endCol = span.EndLinePosition.Character + 1
        return "$file($line,$col,$endLine,$endCol): $severity ${diagnostic.Id}: $message"
    }

    private func Flatten(ex Exception?) string {
        let message = (ex?.Message ?? "unknown error").Replace("\r", " ").Replace("\n", " ")
        return message
    }

    /// Expands any `@file` arguments in place by reading the referenced
    /// response file line by line (skipping blank lines and `#` comments)
    /// and tokenizing each line on unquoted whitespace. Non-`@` arguments
    /// pass through unchanged. Mirrors gsc's response-file handling so the SDK
    /// can invoke both tools identically.
    private func ExpandResponseFiles(args IReadOnlyList[string]) List[string] {
        let result = List[string](args.Count)
        for arg in args {
            if arg != nil && arg.Length > 0 && arg[0] == '@' {
                let path = arg.Substring(1)
                if !File.Exists(path) {
                    throw FileNotFoundException("Response file not found: '$path'.", path)
                }
                for line in File.ReadAllLines(path) {
                    let trimmed = line.Trim()
                    if trimmed.Length == 0 || trimmed[0] == '#' {
                        continue
                    }
                    result.AddRange(TokenizeResponseFileLine(trimmed))
                }
            } else {
                result.Add(arg)
            }
        }
        return result
    }

    /// Splits a single response-file line into tokens on unquoted whitespace,
    /// honoring double-quoted spans (so reference paths under directories with
    /// spaces survive) and doubled `""` as an escaped quote.
    private func TokenizeResponseFileLine(line string) IEnumerable[string] {
        let tokens = List[string]()
        if string.IsNullOrEmpty(line) {
            return tokens
        }
        let sb = StringBuilder()
        var inQuotes = false
        var hasToken = false
        for var i = 0; i < line.Length; i++ {
            let c = line[i]
            if c == '"' {
                if inQuotes && i + 1 < line.Length && line[i + 1] == '"' {
                    sb.Append('"')
                    hasToken = true
                    i++
                } else {
                    inQuotes = !inQuotes
                    hasToken = true
                }
            } else if !inQuotes && char.IsWhiteSpace(c) {
                if hasToken {
                    tokens.Add(sb.ToString())
                    sb.Clear()
                    hasToken = false
                }
            } else {
                sb.Append(c)
                hasToken = true
            }
        }
        if hasToken {
            tokens.Add(sb.ToString())
        }
        return tokens
    }
}

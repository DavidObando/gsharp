// <copyright file="GscInvoker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.RegularExpressions

/// Resolves, version-stamps, and invokes the real `gsc` compiler for
/// stage 2 (ADR-0115 §C). All process I/O is local: it only shells out to
/// `dotnet "<gsc.dll>" …` with slash-colon switches and parses the
/// emitted diagnostics — no network egress, no keys.
class GscInvoker {
    /// Initializes a new instance of the (cref:GscInvoker) class.
    /// @param gscPath The resolved absolute path to `gsc.dll`.
    /// @param gsgenPath Issue #2215: the resolved absolute path to `gsgen.dll`, forwarded
    /// to gsc via `/gsgentool:` whenever an analyzer path is also passed
    /// to (cref:Compile). `null` lets gsc fall back to
    /// its own packaged-sibling-tools default (only valid once packaged; in a
    /// dev tree gsc.dll and gsgen.dll are not siblings, so callers running
    /// against a dev build should resolve and pass this explicitly).
    init(gscPath string, gsgenPath string? = nil) {
        this.GscPath = gscPath ?? throw ArgumentNullException("gscPath")
        this.GsgenPath = gsgenPath
    }

    /// Gets the resolved `gsc.dll` path.
    prop GscPath string {
        get;
    }

    /// Gets the resolved `gsgen.dll` path, or `null` to use gsc's own default.
    prop GsgenPath string? {
        get;
    }

    /// Derives a human-readable `gscVersion` from the compiler assembly:
    /// the informational/product version (which carries the source-control
    /// suffix, e.g. `0.2.106+e2206d0c48`) when present, else the file
    /// version, else the assembly version (ADR-0115 §C).
    /// @returns The version string used to stamp artifacts and retry history.
    func GetVersion() string {
        try {
            let info = FileVersionInfo.GetVersionInfo(this.GscPath)
            if !string.IsNullOrWhiteSpace(info.ProductVersion) {
                return info.ProductVersion!!
            }
            if !string.IsNullOrWhiteSpace(info.FileVersion) {
                return info.FileVersion!!
            }
        } catch (FileNotFoundException) {
            // Fall through to the unknown sentinel.

        }
        return "unknown"
    }

    /// Compiles the supplied G# files with `gsc` and parses the result.
    /// @param gsFiles The absolute paths of the G# source files to compile.
    /// @param outputPath The output assembly path.
    /// @param target The output kind (exe or library).
    /// @param references The assemblies to pass via `/reference:`.
    /// @param analyzerPaths Issue #2215: analyzer/generator assembly paths to pass via gsc's
    /// `/analyzer:` flag. When non-empty, gsc spawns `gsgen` itself
    /// (ADR-0027 — Roslyn never links into gsc) and folds its generated
    /// `.gs` into this same compile, so the pipeline's compiled assembly
    /// carries generator output the way a real MSBuild build would.
    /// @param additionalFiles Issue #2223: non-source generator inputs (e.g. Avalonia `.axaml`),
    /// each optionally suffixed with `;key=value` metadata, passed via gsc's
    /// `/additionalfile:` and forwarded to gsgen as `AdditionalText`.
    /// @param globalOptions Issue #2223: project-wide generator options (`key=value`) passed via
    /// gsc's `/globaloption:` and forwarded to gsgen as
    /// `build_property.*`.
    /// @returns The exit code, combined output, and parsed diagnostics.
    func Compile(
        gsFiles IReadOnlyList[string],
        outputPath string,
        target TargetKind,
        references IReadOnlyList[string]?,
        analyzerPaths IReadOnlyList[string]? = nil,
        additionalFiles IReadOnlyList[string]? = nil,
        globalOptions IReadOnlyList[string]? = nil
    ) GscResult {
        let args = List[string]{
            this.GscPath,
            if target == TargetKind.Exe {
                "/target:exe"
            } else {
                "/target:library"
            },
            "/out:" + outputPath
        }
        if references != nil {
            for reference in references {
                args.Add("/reference:" + reference)
            }
        }
        if analyzerPaths != nil && analyzerPaths.Count > 0 {
            for analyzerPath in analyzerPaths {
                args.Add("/analyzer:" + analyzerPath)
            }
            if !string.IsNullOrEmpty(this.GsgenPath) {
                args.Add("/gsgentool:" + this.GsgenPath)
            }
        }
        if additionalFiles != nil {
            for additionalFile in additionalFiles {
                args.Add("/additionalfile:" + additionalFile)
            }
        }
        if globalOptions != nil {
            for globalOption in globalOptions {
                args.Add("/globaloption:" + globalOption)
            }
        }
        args.AddRange(gsFiles)
        let result = ProcessRunner.Run("dotnet", args)
        let diagnostics = ParseDiagnostics(result.Output)
        return GscResult(result.ExitCode, result.Output, diagnostics)
    }

    shared {
        // Matches a gsc diagnostic line: `<file>(l,c,el,ec): <severity> GSxxxx: <message>`
        // as emitted by TextWriterExtensions.WriteDiagnostics in src/Core/IO.
        private let DiagnosticPattern Regex = Regex(
            "^(?<file>.*)\\((?<line>\\d+),(?<col>\\d+),(?<eline>\\d+),(?<ecol>\\d+)\\):\\s+" +
                "(?<sev>error|warning|info)\\s+(?<id>GS\\d+):\\s+(?<msg>.*)$$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )

        /// Resolves the `gsc.dll` to use: the explicit override when supplied,
        /// otherwise the first `out/bin/<Config>/Compiler/gsc.dll` found
        /// by walking up from [`startDirectory`](paramref) (ADR-0115 §C).
        /// @param explicitPath The `--gsc` override, or `null`.
        /// @param config The build configuration to probe (e.g. `Release`).
        /// @param startDirectory The directory to begin the upward walk from.
        /// @returns The resolved path, or `null` if none was found.
        func Resolve(explicitPath string?, config string, startDirectory string) string? -> ResolveSiblingTool(
            explicitPath,
            config,
            startDirectory,
            "Compiler",
            "gsc.dll"
        )

        /// Issue #2215: resolves the `gsgen.dll` to use, the same way
        /// (cref:Resolve) resolves gsc — the explicit override when
        /// supplied, otherwise the first `out/bin/<Config>/Gsgen.Cli/gsgen.dll`
        /// found by walking up from each supplied start directory in order. In a dev
        /// tree, gsc.dll and gsgen.dll do NOT live in sibling directories (unlike
        /// the packaged SDK NuGet), so cs2gs must resolve this explicitly and pass
        /// it via `/gsgentool:` for `/analyzer:` to work outside a packaged install.
        /// @param explicitPath The `--gsgen` override, or `null`.
        /// @param config The build configuration to probe (e.g. `Release`).
        /// @param startDirectories Directories to begin upward walks from, in priority order.
        /// @returns The resolved path, or `null` if none was found.
        func ResolveGsgenTool(explicitPath string?, config string, startDirectories ...string) string? {
            if !string.IsNullOrEmpty(explicitPath) {
                return if File.Exists(explicitPath) {
                    Path.GetFullPath(explicitPath)
                } else {
                    default(string?)
                }
            }
            for startDirectory in startDirectories {
                if string.IsNullOrWhiteSpace(startDirectory) {
                    continue
                }
                let resolved string? = ResolveSiblingTool(nil, config, startDirectory, "Gsgen.Cli", "gsgen.dll")
                if resolved != nil {
                    return resolved
                }
            }
            return nil
        }

        /// Parses every `GSxxxx` diagnostic line out of combined compiler output.
        /// @param output The combined stdout+stderr of a `gsc` run.
        /// @returns The parsed diagnostics in source order.
        func ParseDiagnostics(output string) IReadOnlyList[GscDiagnostic] {
            let diagnostics = List[GscDiagnostic]()
            if string.IsNullOrEmpty(output) {
                return diagnostics
            }
            for rawLine in output.Replace("\r\n", "\n").Split('\n') {
                let match = DiagnosticPattern.Match(rawLine.Trim())
                if !match.Success {
                    continue
                }
                diagnostics.Add(
                    GscDiagnostic(
                        match.Groups["id"].Value,
                        match.Groups["msg"].Value.Trim(),
                        match.Groups["sev"].Value,
                        match.Groups["file"].Value.Trim(),
                        int32.Parse(match.Groups["line"].Value),
                        int32.Parse(match.Groups["col"].Value),
                        int32.Parse(match.Groups["eline"].Value),
                        int32.Parse(match.Groups["ecol"].Value)
                    )
                )
            }
            return diagnostics
        }

        private func ResolveSiblingTool(
            explicitPath string?,
            config string,
            startDirectory string,
            projectDirName string,
            dllName string
        ) string? {
            if !string.IsNullOrEmpty(explicitPath) {
                return if File.Exists(explicitPath) {
                    Path.GetFullPath(explicitPath)
                } else {
                    default(string?)
                }
            }
            let configs = if string.IsNullOrEmpty(config) {
                []string{"Release", "Debug"}
            } else {
                []string{config, "Release", "Debug"}
            }
            var dir DirectoryInfo? = DirectoryInfo(startDirectory)
            while dir != nil {
                for cfg in configs {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", cfg, projectDirName, dllName)
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}

/// A single parsed `gsc` diagnostic (ADR-0115 §C/§D.1).
class GscDiagnostic {
    /// Initializes a new instance of the (cref:GscDiagnostic) class.
    /// @param id The diagnostic id (e.g. `GS0001`).
    /// @param message The diagnostic message.
    /// @param severity The severity (`error`/`warning`/`info`).
    /// @param file The G# source file the diagnostic anchors to.
    /// @param line The 1-based line.
    /// @param column The 1-based column.
    convenience init(id string, message string, severity string, file string, line int32, column int32) {
        init(id, message, severity, file, line, column, line, column)
    }

    /// Initializes a new instance of the (cref:GscDiagnostic) class
    /// with an explicit end position (issue #3501 polish pass — the
    /// GS0536 strip needs the exact span of the `!!` token).
    /// @param id The diagnostic id (e.g. `GS0001`).
    /// @param message The diagnostic message.
    /// @param severity The severity (`error`/`warning`/`info`).
    /// @param file The G# source file the diagnostic anchors to.
    /// @param line The 1-based start line.
    /// @param column The 1-based start column.
    /// @param endLine The 1-based end line.
    /// @param endColumn The 1-based end column (exclusive).
    init(
        id string,
        message string,
        severity string,
        file string,
        line int32,
        column int32,
        endLine int32,
        endColumn int32
    ) {
        this.Id = id
        this.Message = message
        this.Severity = severity
        this.File = file
        this.Line = line
        this.Column = column
        this.EndLine = endLine
        this.EndColumn = endColumn
    }

    /// Gets the diagnostic id.
    prop Id string {
        get;
    }

    /// Gets the diagnostic message.
    prop Message string {
        get;
    }

    /// Gets the severity string.
    prop Severity string {
        get;
    }

    /// Gets the G# source file the diagnostic anchors to.
    prop File string {
        get;
    }

    /// Gets the 1-based line.
    prop Line int32 {
        get;
    }

    /// Gets the 1-based column.
    prop Column int32 {
        get;
    }

    /// Gets the 1-based end line (issue #3501 polish pass).
    prop EndLine int32 {
        get;
    }

    /// Gets the 1-based end column, exclusive (issue #3501 polish pass).
    prop EndColumn int32 {
        get;
    }

    /// Gets a value indicating whether this is an error-severity diagnostic.
    prop IsError bool -> string.Equals(this.Severity, "error", StringComparison.OrdinalIgnoreCase)
}

/// The outcome of a (cref:GscInvoker.Compile) invocation.
class GscResult {
    /// Initializes a new instance of the (cref:GscResult) class.
    /// @param exitCode The compiler process exit code.
    /// @param output The combined stdout+stderr.
    /// @param diagnostics The parsed diagnostics.
    init(exitCode int32, output string, diagnostics IReadOnlyList[GscDiagnostic]) {
        this.ExitCode = exitCode
        this.Output = output
        this.Diagnostics = diagnostics
    }

    /// Gets the compiler process exit code.
    prop ExitCode int32 {
        get;
    }

    /// Gets the combined stdout+stderr.
    prop Output string {
        get;
    }

    /// Gets the parsed diagnostics.
    prop Diagnostics IReadOnlyList[GscDiagnostic] {
        get;
    }

    /// Gets the error-severity diagnostics.
    prop Errors IReadOnlyList[GscDiagnostic] -> this.Diagnostics.Where((d GscDiagnostic) -> d.IsError).ToList()

    /// Gets a value indicating whether the compile passed the stage-2 gate:
    /// exit 0 and zero error-severity diagnostics (ADR-0115 §C).
    prop Succeeded bool -> this.ExitCode == 0 && this.Errors.Count == 0
}

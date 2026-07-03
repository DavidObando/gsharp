// <copyright file="GscInvoker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Resolves, version-stamps, and invokes the real <c>gsc</c> compiler for
/// stage 2 (ADR-0115 §C). All process I/O is local: it only shells out to
/// <c>dotnet "&lt;gsc.dll&gt;" …</c> with slash-colon switches and parses the
/// emitted diagnostics — no network egress, no keys.
/// </summary>
public sealed class GscInvoker
{
    // Matches a gsc diagnostic line: `<file>(l,c,el,ec): <severity> GSxxxx: <message>`
    // as emitted by TextWriterExtensions.WriteDiagnostics in src/Core/IO.
    private static readonly Regex DiagnosticPattern = new Regex(
        @"^(?<file>.*)\((?<line>\d+),(?<col>\d+),(?<eline>\d+),(?<ecol>\d+)\):\s+" +
        @"(?<sev>error|warning|info)\s+(?<id>GS\d+):\s+(?<msg>.*)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Initializes a new instance of the <see cref="GscInvoker"/> class.
    /// </summary>
    /// <param name="gscPath">The resolved absolute path to <c>gsc.dll</c>.</param>
    public GscInvoker(string gscPath)
    {
        this.GscPath = gscPath ?? throw new ArgumentNullException(nameof(gscPath));
    }

    /// <summary>Gets the resolved <c>gsc.dll</c> path.</summary>
    public string GscPath { get; }

    /// <summary>
    /// Resolves the <c>gsc.dll</c> to use: the explicit override when supplied,
    /// otherwise the first <c>out/bin/&lt;Config&gt;/Compiler/gsc.dll</c> found
    /// by walking up from <paramref name="startDirectory"/> (ADR-0115 §C).
    /// </summary>
    /// <param name="explicitPath">The <c>--gsc</c> override, or <see langword="null"/>.</param>
    /// <param name="config">The build configuration to probe (e.g. <c>Release</c>).</param>
    /// <param name="startDirectory">The directory to begin the upward walk from.</param>
    /// <returns>The resolved path, or <see langword="null"/> if none was found.</returns>
    public static string Resolve(string explicitPath, string config, string startDirectory)
    {
        if (!string.IsNullOrEmpty(explicitPath))
        {
            return File.Exists(explicitPath) ? Path.GetFullPath(explicitPath) : null;
        }

        var configs = string.IsNullOrEmpty(config)
            ? new[] { "Release", "Debug" }
            : new[] { config, "Release", "Debug" };

        var dir = new DirectoryInfo(startDirectory);
        while (dir is not null)
        {
            foreach (string cfg in configs)
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", cfg, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    /// <summary>
    /// Derives a human-readable <c>gscVersion</c> from the compiler assembly:
    /// the informational/product version (which carries the source-control
    /// suffix, e.g. <c>0.2.106+e2206d0c48</c>) when present, else the file
    /// version, else the assembly version (ADR-0115 §C).
    /// </summary>
    /// <returns>The version string used to stamp artifacts and retry history.</returns>
    public string GetVersion()
    {
        try
        {
            FileVersionInfo info = FileVersionInfo.GetVersionInfo(this.GscPath);
            if (!string.IsNullOrWhiteSpace(info.ProductVersion))
            {
                return info.ProductVersion;
            }

            if (!string.IsNullOrWhiteSpace(info.FileVersion))
            {
                return info.FileVersion;
            }
        }
        catch (FileNotFoundException)
        {
            // Fall through to the unknown sentinel.
        }

        return "unknown";
    }

    /// <summary>
    /// Compiles the supplied G# files with <c>gsc</c> and parses the result.
    /// </summary>
    /// <param name="gsFiles">The absolute paths of the G# source files to compile.</param>
    /// <param name="outputPath">The output assembly path.</param>
    /// <param name="target">The output kind (exe or library).</param>
    /// <param name="references">The assemblies to pass via <c>/reference:</c>.</param>
    /// <returns>The exit code, combined output, and parsed diagnostics.</returns>
    public GscResult Compile(
        IReadOnlyList<string> gsFiles,
        string outputPath,
        TargetKind target,
        IReadOnlyList<string> references)
    {
        var args = new List<string>
        {
            this.GscPath,
            target == TargetKind.Exe ? "/target:exe" : "/target:library",
            "/out:" + outputPath,
        };

        if (references is not null)
        {
            foreach (string reference in references)
            {
                args.Add("/reference:" + reference);
            }
        }

        args.AddRange(gsFiles);

        ProcessRunResult result = ProcessRunner.Run("dotnet", args);
        IReadOnlyList<GscDiagnostic> diagnostics = ParseDiagnostics(result.Output);
        return new GscResult(result.ExitCode, result.Output, diagnostics);
    }

    /// <summary>
    /// Parses every <c>GSxxxx</c> diagnostic line out of combined compiler output.
    /// </summary>
    /// <param name="output">The combined stdout+stderr of a <c>gsc</c> run.</param>
    /// <returns>The parsed diagnostics in source order.</returns>
    public static IReadOnlyList<GscDiagnostic> ParseDiagnostics(string output)
    {
        var diagnostics = new List<GscDiagnostic>();
        if (string.IsNullOrEmpty(output))
        {
            return diagnostics;
        }

        foreach (string rawLine in output.Replace("\r\n", "\n").Split('\n'))
        {
            Match match = DiagnosticPattern.Match(rawLine.Trim());
            if (!match.Success)
            {
                continue;
            }

            diagnostics.Add(new GscDiagnostic(
                match.Groups["id"].Value,
                match.Groups["msg"].Value.Trim(),
                match.Groups["sev"].Value,
                match.Groups["file"].Value.Trim(),
                int.Parse(match.Groups["line"].Value),
                int.Parse(match.Groups["col"].Value)));
        }

        return diagnostics;
    }
}

/// <summary>
/// A single parsed <c>gsc</c> diagnostic (ADR-0115 §C/§D.1).
/// </summary>
public sealed class GscDiagnostic
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GscDiagnostic"/> class.
    /// </summary>
    /// <param name="id">The diagnostic id (e.g. <c>GS0001</c>).</param>
    /// <param name="message">The diagnostic message.</param>
    /// <param name="severity">The severity (<c>error</c>/<c>warning</c>/<c>info</c>).</param>
    /// <param name="file">The G# source file the diagnostic anchors to.</param>
    /// <param name="line">The 1-based line.</param>
    /// <param name="column">The 1-based column.</param>
    public GscDiagnostic(string id, string message, string severity, string file, int line, int column)
    {
        this.Id = id;
        this.Message = message;
        this.Severity = severity;
        this.File = file;
        this.Line = line;
        this.Column = column;
    }

    /// <summary>Gets the diagnostic id.</summary>
    public string Id { get; }

    /// <summary>Gets the diagnostic message.</summary>
    public string Message { get; }

    /// <summary>Gets the severity string.</summary>
    public string Severity { get; }

    /// <summary>Gets the G# source file the diagnostic anchors to.</summary>
    public string File { get; }

    /// <summary>Gets the 1-based line.</summary>
    public int Line { get; }

    /// <summary>Gets the 1-based column.</summary>
    public int Column { get; }

    /// <summary>Gets a value indicating whether this is an error-severity diagnostic.</summary>
    public bool IsError => string.Equals(this.Severity, "error", StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// The outcome of a <see cref="GscInvoker.Compile"/> invocation.
/// </summary>
public sealed class GscResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GscResult"/> class.
    /// </summary>
    /// <param name="exitCode">The compiler process exit code.</param>
    /// <param name="output">The combined stdout+stderr.</param>
    /// <param name="diagnostics">The parsed diagnostics.</param>
    public GscResult(int exitCode, string output, IReadOnlyList<GscDiagnostic> diagnostics)
    {
        this.ExitCode = exitCode;
        this.Output = output;
        this.Diagnostics = diagnostics;
    }

    /// <summary>Gets the compiler process exit code.</summary>
    public int ExitCode { get; }

    /// <summary>Gets the combined stdout+stderr.</summary>
    public string Output { get; }

    /// <summary>Gets the parsed diagnostics.</summary>
    public IReadOnlyList<GscDiagnostic> Diagnostics { get; }

    /// <summary>Gets the error-severity diagnostics.</summary>
    public IReadOnlyList<GscDiagnostic> Errors =>
        this.Diagnostics.Where(d => d.IsError).ToList();

    /// <summary>
    /// Gets a value indicating whether the compile passed the stage-2 gate:
    /// exit 0 and zero error-severity diagnostics (ADR-0115 §C).
    /// </summary>
    public bool Succeeded => this.ExitCode == 0 && this.Errors.Count == 0;
}

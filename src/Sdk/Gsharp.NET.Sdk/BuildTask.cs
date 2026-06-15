// <copyright file="BuildTask.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using Microsoft.Build.Framework;
using Microsoft.Build.Utilities;

namespace Gsharp.NET.Sdk.Tools;

/// <summary>
/// MSBuild task that invokes <c>gsc</c> to compile a set of <c>.gs</c> sources
/// into a managed assembly. Modeled after Peachpie's
/// <c>Peachpie.NET.Sdk.Tools.BuildTask</c>.
/// </summary>
public class BuildTask : Microsoft.Build.Utilities.Task, ICancelableTask
{
    private readonly CancellationTokenSource cts = new();

    /// <summary>
    /// Matches gsc's canonical diagnostic header line
    /// <c>file(startLine,startCol,endLine,endCol): error|warning|info CODE: message</c>
    /// so it can be re-emitted through the MSBuild logger with structured
    /// location, code, and severity. End line/column are optional.
    /// </summary>
    private static readonly System.Text.RegularExpressions.Regex DiagnosticLine =
        new(
            @"^(?<file>[^(]+)\((?<l1>\d+),(?<c1>\d+)(?:,(?<l2>\d+),(?<c2>\d+))?\):\s*(?<sev>error|warning|info)\s+(?<code>[^:]+):\s*(?<msg>.*)$",
            System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>Gets or sets the full path to gsc.dll.</summary>
    [Required]
    public string GsharpCompilerFullPath { get; set; }

    /// <summary>Gets or sets the directory where the final assembly is written.</summary>
    [Required]
    public string OutputPath { get; set; }

    /// <summary>Gets or sets the base name (without extension) of the output assembly.</summary>
    [Required]
    public string OutputName { get; set; }

    /// <summary>Gets or sets the temporary output (obj) path.</summary>
    [Required]
    public string TempOutputPath { get; set; }

    /// <summary>Gets or sets the target framework moniker (e.g. net10.0).</summary>
    [Required]
    public string TargetFramework { get; set; }

    /// <summary>Gets or sets the path of the response file to be written.</summary>
    public string ResponseFilePath { get; set; }

    /// <summary>Gets or sets the project base directory, used to resolve relative source paths.</summary>
    public string BasePath { get; set; }

    /// <summary>Gets or sets the optimization level (bool, level number, or "debug"/"release").</summary>
    public string Optimization { get; set; } = bool.TrueString;

    /// <summary>Gets or sets the requested debug type (full/portable/embedded/none).</summary>
    public string DebugType { get; set; }

    /// <summary>Gets or sets the PDB output path.</summary>
    public string PdbFile { get; set; }

    /// <summary>Gets or sets the path to a Source Link JSON file (forwarded to <c>gsc /sourcelink:</c>).</summary>
    public string SourceLink { get; set; }

    /// <summary>
    /// Gets or sets a value (parsed as a bool) controlling whether all primary
    /// source files are embedded in the Portable PDB (forwarded as
    /// <c>gsc /embed</c>). Maps to MSBuild's <c>EmbedAllSources</c> property.
    /// </summary>
    public string EmbedAllSources { get; set; }

    /// <summary>
    /// Gets or sets a value (parsed as a bool) controlling deterministic emit
    /// (forwarded as <c>gsc /deterministic</c>). Maps to MSBuild's
    /// <c>Deterministic</c> property.
    /// </summary>
    public string Deterministic { get; set; }

    /// <summary>Gets or sets the assembly version stamped on the output.</summary>
    public string Version { get; set; }

    /// <summary>Gets or sets the MSBuild OutputType (Exe / Library).</summary>
    public string OutputType { get; set; }

    /// <summary>Gets or sets the path of the metadata-only reference assembly to write (refint).</summary>
    public string RefAssembly { get; set; }

    /// <summary>Gets or sets the path of the XML documentation file to write.</summary>
    public string DocumentationFile { get; set; }

    /// <summary>Gets or sets the comma-separated list of diagnostic IDs to suppress (NoWarn MSBuild property).</summary>
    public string NoWarn { get; set; }

    /// <summary>Gets or sets a value indicating whether all warnings should be treated as errors (TreatWarningsAsErrors MSBuild property).</summary>
    public string TreatWarningsAsErrors { get; set; }

    /// <summary>Gets or sets the comma-separated list of diagnostic IDs to promote to errors (WarningsAsErrors MSBuild property).</summary>
    public string WarningsAsErrors { get; set; }

    /// <summary>Gets or sets the Compile item group (the .gs sources).</summary>
    public ITaskItem[] Compile { get; set; } = Array.Empty<ITaskItem>();

    /// <summary>Gets or sets the ReferencePath item group (resolved metadata references).</summary>
    public ITaskItem[] References { get; set; } = Array.Empty<ITaskItem>();

    /// <inheritdoc/>
    public void Cancel() => this.cts.Cancel();

    /// <inheritdoc/>
    public override bool Execute()
    {
        if (this.Compile == null || this.Compile.Length == 0)
        {
            this.Log.LogError("No .gs sources to compile (the Compile item group is empty).");
            return false;
        }

        var args = new List<string>
        {
            QuoteIfNeeded($"/out:{Path.Combine(this.OutputPath, this.OutputName)}.dll"),
        };
        if (!string.IsNullOrEmpty(this.OutputName))
        {
            args.Add(QuoteIfNeeded($"/assemblyname:{this.OutputName}"));
        }

        if (!string.IsNullOrEmpty(this.OutputType))
        {
            var t = this.OutputType.Equals("Exe", StringComparison.OrdinalIgnoreCase) ? "exe" : "library";
            args.Add($"/target:{t}");
        }

        if (!string.IsNullOrEmpty(this.TargetFramework))
        {
            args.Add($"/targetframework:{this.TargetFramework}");
        }

        if (!string.IsNullOrEmpty(this.DebugType))
        {
            args.Add($"/debug:{this.DebugType}");
        }

        if (!string.IsNullOrEmpty(this.PdbFile))
        {
            args.Add(QuoteIfNeeded($"/pdb:{this.PdbFile}"));
        }

        if (!string.IsNullOrEmpty(this.SourceLink))
        {
            args.Add(QuoteIfNeeded($"/sourcelink:{this.SourceLink}"));
        }

        if (ParseBool(this.EmbedAllSources))
        {
            args.Add("/embed+");
        }

        if (ParseBool(this.Deterministic))
        {
            args.Add("/deterministic+");
        }

        if (!string.IsNullOrEmpty(this.Version))
        {
            args.Add($"/version:{this.Version}");
        }

        if (!string.IsNullOrEmpty(this.RefAssembly))
        {
            args.Add(QuoteIfNeeded($"/refout:{this.RefAssembly}"));
        }

        if (!string.IsNullOrEmpty(this.DocumentationFile))
        {
            args.Add(QuoteIfNeeded($"/doc:{this.DocumentationFile}"));
        }

        if (!string.IsNullOrEmpty(this.NoWarn))
        {
            args.Add($"/nowarn:{this.NoWarn}");
        }

        if (!string.IsNullOrEmpty(this.WarningsAsErrors))
        {
            args.Add($"/warnaserror+:{this.WarningsAsErrors}");
        }

        if (string.Equals(this.TreatWarningsAsErrors, "true", StringComparison.OrdinalIgnoreCase))
        {
            args.Add("/warnaserror");
        }

        foreach (var r in this.References)
        {
            args.Add(QuoteIfNeeded($"/r:{r.ItemSpec}"));
        }

        foreach (var s in this.Compile)
        {
            args.Add(QuoteIfNeeded(s.ItemSpec));
        }

        if (!string.IsNullOrEmpty(this.ResponseFilePath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(this.ResponseFilePath));
            File.WriteAllLines(this.ResponseFilePath, args, Encoding.UTF8);
        }

        var psi = new ProcessStartInfo("dotnet", $"\"{this.GsharpCompilerFullPath}\" @\"{this.ResponseFilePath}\"")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = this.BasePath ?? Environment.CurrentDirectory,
        };

        using var proc = Process.Start(psi);
        string lastStdoutLine = null;
        string lastStderrLine = null;
        proc.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null)
            {
                lastStdoutLine = e.Data;
                this.LogCompilerLine(e.Data);
            }
        };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data == null)
            {
                return;
            }

            lastStderrLine = e.Data;

            // "Failed." is gsc's terminal exit sentinel, not a diagnostic; the
            // real errors are surfaced from stdout via LogCompilerLine. Demote
            // it to a low-importance message so the build error list shows the
            // actual diagnostics instead of an opaque "Failed.".
            if (string.Equals(e.Data.Trim(), "Failed.", StringComparison.Ordinal))
            {
                this.Log.LogMessage(MessageImportance.Low, e.Data);
            }
            else
            {
                this.Log.LogError(e.Data);
            }
        };
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        proc.WaitForExit();

        // Issue #519 + 6.2 SilentEmitFailure invariant (boundary ring): when
        // gsc exits non-zero but no structured diagnostic was logged, anchor
        // the synthetic GS9998 at the first Compile item (so the IDE error
        // pane navigates to a source file, not gsc.dll). Include the last
        // captured output as a breadcrumb.
        if (proc.ExitCode != 0 && !this.Log.HasLoggedErrors)
        {
            var anchorFile = this.Compile?.Length > 0
                ? this.Compile[0].ItemSpec
                : (this.GsharpCompilerFullPath ?? "gsc");

            var lastOutput = lastStderrLine ?? lastStdoutLine;
            var breadcrumb = string.IsNullOrWhiteSpace(lastOutput)
                ? string.Empty
                : $" Last compiler output: {lastOutput}";

            this.Log.LogError(
                subcategory: null,
                errorCode: "GS9998",
                helpKeyword: null,
                file: anchorFile,
                lineNumber: 1,
                columnNumber: 1,
                endLineNumber: 1,
                endColumnNumber: 1,
                message: $"gsc exited with code {proc.ExitCode} without emitting a structured diagnostic.{breadcrumb}");
        }

        return proc.ExitCode == 0 && !this.Log.HasLoggedErrors;
    }

    /// <summary>
    /// Wraps <paramref name="value"/> in double quotes if it contains a
    /// whitespace character. The gsc response file tokenizer
    /// (<c>Program.TokenizeResponseFileLine</c>) splits on unquoted whitespace,
    /// so any argument that embeds a space (e.g. a reference path under
    /// <c>C:\Program Files\dotnet\...</c>) must be quoted to survive
    /// tokenization as a single token. See issue #856.
    /// </summary>
    /// <param name="value">Raw argument text to be written to the response file.</param>
    /// <returns>
    /// <paramref name="value"/> unchanged when it is null, empty, or contains
    /// no whitespace; otherwise the value wrapped in a single pair of double
    /// quotes.
    /// </returns>
    internal static string QuoteIfNeeded(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }

        for (int i = 0; i < value.Length; i++)
        {
            if (char.IsWhiteSpace(value[i]))
            {
                return "\"" + value + "\"";
            }
        }

        return value;
    }

    /// <summary>
    /// Routes a single line of gsc stdout to the MSBuild logger. Diagnostic
    /// header lines become structured errors/warnings (so they appear in the
    /// build error list and editor problem panes); all other lines — including
    /// the source snippets gsc prints under each diagnostic — are logged at low
    /// importance to keep default-verbosity output clean.
    /// </summary>
    /// <param name="line">A line written by gsc to standard output.</param>
    private void LogCompilerLine(string line)
    {
        var match = DiagnosticLine.Match(line);
        if (!match.Success)
        {
            this.Log.LogMessage(MessageImportance.Low, line);
            return;
        }

        var file = match.Groups["file"].Value.Trim();
        var code = match.Groups["code"].Value.Trim();
        var message = match.Groups["msg"].Value;
        var startLine = int.Parse(match.Groups["l1"].Value);
        var startColumn = int.Parse(match.Groups["c1"].Value);
        var endLine = match.Groups["l2"].Success ? int.Parse(match.Groups["l2"].Value) : 0;
        var endColumn = match.Groups["c2"].Success ? int.Parse(match.Groups["c2"].Value) : 0;

        switch (match.Groups["sev"].Value)
        {
            case "error":
                this.Log.LogError(null, code, null, file, startLine, startColumn, endLine, endColumn, message);
                break;
            case "warning":
                // GS9100 is advisory (missing transitive references) — only surface
                // at detailed/diagnostic verbosity to keep normal builds quiet.
                if (string.Equals(code, "GS9100", StringComparison.OrdinalIgnoreCase))
                {
                    this.Log.LogMessage(MessageImportance.Low, line);
                }
                else
                {
                    this.Log.LogWarning(null, code, null, file, startLine, startColumn, endLine, endColumn, message);
                }

                break;
            default:
                this.Log.LogMessage(MessageImportance.Normal, line);
                break;
        }
    }

    /// <summary>
    /// Parses an MSBuild bool-style property value. Accepts the canonical
    /// <c>"true"</c> / <c>"false"</c> spellings (case-insensitive) and treats
    /// empty / null / unrecognized values as <see langword="false"/>.
    /// </summary>
    private static bool ParseBool(string value) =>
        !string.IsNullOrEmpty(value) && bool.TryParse(value, out var b) && b;
}

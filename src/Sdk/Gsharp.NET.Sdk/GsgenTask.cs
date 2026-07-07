// <copyright file="GsgenTask.cs" company="GSharp">
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
/// MSBuild task that invokes the <c>gsgen</c> source-generator host (ADR-0145
/// §E/§F) before <c>CoreCompile</c>. It projects the user's <c>.gs</c> sources to
/// a C# stub, runs the supplied Roslyn generators over that stub, and writes the
/// back-translated <c>.g.gs</c> parts (plus a newline manifest) to the output
/// directory so the SDK can feed them into gsc.
/// </summary>
/// <remarks>
/// Modeled EXACTLY on <see cref="BuildTask"/>: same <c>dotnet &lt;tool&gt;.dll
/// @rsp</c> process launch, the same response-file writer, the same
/// <see cref="DiagnosticLine"/> relay (gsgen emits diagnostics in gsc's canonical
/// header format), and the same cancellation registration that kills the child
/// process when MSBuild cancels the build.
/// </remarks>
public class GsgenTask : Microsoft.Build.Utilities.Task, ICancelableTask
{
    private readonly CancellationTokenSource cts = new();

    /// <summary>
    /// Matches gsgen's canonical diagnostic header line
    /// <c>file(startLine,startCol,endLine,endCol): error|warning|info CODE: message</c>
    /// (identical to gsc's format) so it can be re-emitted through the MSBuild
    /// logger with structured location, code, and severity. End line/column are
    /// optional.
    /// </summary>
    private static readonly System.Text.RegularExpressions.Regex DiagnosticLine =
        new(
            @"^(?<file>[^(]+)\((?<l1>\d+),(?<c1>\d+)(?:,(?<l2>\d+),(?<c2>\d+))?\):\s*(?<sev>error|warning|info)\s+(?<code>[^:]+):\s*(?<msg>.*)$",
            System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>Gets or sets the full path to gsgen.dll.</summary>
    [Required]
    public string GsgenToolFullPath { get; set; }

    /// <summary>Gets or sets the Compile item group (the user's .gs sources).</summary>
    public ITaskItem[] Compile { get; set; } = Array.Empty<ITaskItem>();

    /// <summary>
    /// Gets or sets "foreign" C# <c>Compile</c> items (issue #2214) — a stray
    /// <c>.cs</c> file the SDK found in the project's own <c>@(Compile)</c>
    /// (e.g. Nerdbank.GitVersioning's generated <c>ThisAssembly.cs</c>, added
    /// as an ordinary <c>Compile</c> item by its own MSBuild target) rather
    /// than hand-written G#. gsgen translates these directly to G# — no stub
    /// projection or generator run — and folds the result into <c>@(Compile)</c>
    /// the same way as generator output.
    /// </summary>
    public ITaskItem[] ForeignCompile { get; set; } = Array.Empty<ITaskItem>();

    /// <summary>Gets or sets the resolved metadata references (forwarded via /r:).</summary>
    public ITaskItem[] References { get; set; } = Array.Empty<ITaskItem>();

    /// <summary>Gets or sets the analyzer/generator assembly paths (forwarded via /analyzer:).</summary>
    public ITaskItem[] Analyzers { get; set; } = Array.Empty<ITaskItem>();

    /// <summary>Gets or sets the output directory for the generated .g.gs files (/out:).</summary>
    [Required]
    public string OutputDir { get; set; }

    /// <summary>Gets or sets the manifest path receiving the newline-separated generated-file list (/manifest:).</summary>
    [Required]
    public string ManifestPath { get; set; }

    /// <summary>Gets or sets the optional root namespace (/rootnamespace:).</summary>
    public string RootNamespace { get; set; }

    /// <summary>Gets or sets the path of the response file to be written.</summary>
    [Required]
    public string ResponseFilePath { get; set; }

    /// <summary>Gets or sets the project base directory, used as the process working directory.</summary>
    public string BasePath { get; set; }

    /// <inheritdoc/>
    public void Cancel() => this.cts.Cancel();

    /// <inheritdoc/>
    public override bool Execute()
    {
        // No sources means nothing to project; treat as a no-op success (gsgen
        // itself requires at least one /gs:, so we never launch it empty).
        if (this.Compile == null || this.Compile.Length == 0)
        {
            return true;
        }

        var args = new List<string>();

        foreach (var s in this.Compile)
        {
            args.Add(BuildTask.QuoteIfNeeded($"/gs:{s.ItemSpec}"));
        }

        foreach (var r in this.References)
        {
            args.Add(BuildTask.QuoteIfNeeded($"/r:{r.ItemSpec}"));
        }

        foreach (var a in this.Analyzers)
        {
            args.Add(BuildTask.QuoteIfNeeded($"/analyzer:{a.ItemSpec}"));
        }

        foreach (var c in this.ForeignCompile)
        {
            args.Add(BuildTask.QuoteIfNeeded($"/csfile:{c.ItemSpec}"));
        }

        args.Add(BuildTask.QuoteIfNeeded($"/out:{this.OutputDir}"));
        args.Add(BuildTask.QuoteIfNeeded($"/manifest:{this.ManifestPath}"));

        if (!string.IsNullOrEmpty(this.RootNamespace))
        {
            args.Add(BuildTask.QuoteIfNeeded($"/rootnamespace:{this.RootNamespace}"));
        }

        Directory.CreateDirectory(Path.GetDirectoryName(this.ResponseFilePath));
        File.WriteAllLines(this.ResponseFilePath, args, Encoding.UTF8);

        var psi = new ProcessStartInfo("dotnet", $"\"{this.GsgenToolFullPath}\" @\"{this.ResponseFilePath}\"")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = this.BasePath ?? Environment.CurrentDirectory,
        };

        Process proc;
        try
        {
            proc = Process.Start(psi);
        }
        catch (Exception ex)
        {
            // Hard failure: the gsgen process could not even be launched.
            this.Log.LogError($"Failed to launch gsgen ('{this.GsgenToolFullPath}'): {ex.Message}");
            return false;
        }

        using (proc)
        {
            // Mirror BuildTask (issue #1667): register the cancellation token so an
            // MSBuild Cancel() actually kills the child gsgen process instead of
            // blocking in WaitForExit() until it finishes on its own.
            using var cancelRegistration = this.cts.Token.Register(() =>
            {
                try
                {
                    // netstandard2.0 (this task's TFM) lacks Process.Kill(bool);
                    // gsgen doesn't spawn grandchildren, so killing it directly
                    // stops the generator run.
                    proc.Kill();
                }
                catch (InvalidOperationException)
                {
                    // Process already exited.
                }
            });

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
                this.Log.LogError(e.Data);
            };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            proc.WaitForExit();

            if (this.cts.IsCancellationRequested)
            {
                // Build was cancelled: gsgen was killed above; report failure
                // without logging a spurious "exited with code N" error.
                return false;
            }

            // Boundary-ring invariant (mirrors BuildTask GS9998): if gsgen exits
            // non-zero without emitting a structured diagnostic, anchor a synthetic
            // GS9998 at the first Compile item so the IDE navigates to a source
            // file, not gsgen.dll.
            if (proc.ExitCode != 0 && !this.Log.HasLoggedErrors)
            {
                var anchorFile = this.Compile?.Length > 0
                    ? this.Compile[0].ItemSpec
                    : (this.GsgenToolFullPath ?? "gsgen");

                var lastOutput = lastStderrLine ?? lastStdoutLine;
                var breadcrumb = string.IsNullOrWhiteSpace(lastOutput)
                    ? string.Empty
                    : $" Last generator output: {lastOutput}";

                this.Log.LogError(
                    subcategory: null,
                    errorCode: "GS9998",
                    helpKeyword: null,
                    file: anchorFile,
                    lineNumber: 1,
                    columnNumber: 1,
                    endLineNumber: 1,
                    endColumnNumber: 1,
                    message: $"gsgen exited with code {proc.ExitCode} without emitting a structured diagnostic.{breadcrumb}");
            }

            // Return false only on a hard failure: a non-zero exit AND at least one
            // logged error. Generator warnings/info alone never fail the build.
            return proc.ExitCode == 0 || !this.Log.HasLoggedErrors;
        }
    }

    /// <summary>
    /// Routes a single line of gsgen stdout to the MSBuild logger. Diagnostic
    /// header lines become structured errors/warnings; all other lines are logged
    /// at low importance to keep default-verbosity output clean. Mirrors
    /// <see cref="BuildTask"/>'s relay.
    /// </summary>
    /// <param name="line">A line written by gsgen to standard output.</param>
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
                this.Log.LogWarning(null, code, null, file, startLine, startColumn, endLine, endColumn, message);
                break;
            default:
                this.Log.LogMessage(MessageImportance.Normal, line);
                break;
        }
    }
}

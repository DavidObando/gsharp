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
            $"/out:{Path.Combine(this.OutputPath, this.OutputName)}.dll",
        };
        if (!string.IsNullOrEmpty(this.OutputName))
        {
            args.Add($"/assemblyname:{this.OutputName}");
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
            args.Add($"/pdb:{this.PdbFile}");
        }

        if (!string.IsNullOrEmpty(this.SourceLink))
        {
            args.Add($"/sourcelink:{this.SourceLink}");
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
            args.Add($"/refout:{this.RefAssembly}");
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
            args.Add($"/r:{r.ItemSpec}");
        }

        foreach (var s in this.Compile)
        {
            args.Add(s.ItemSpec);
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
        proc.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null)
            {
                this.Log.LogMessage(MessageImportance.Normal, e.Data);
            }
        };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null)
            {
                this.Log.LogError(e.Data);
            }
        };
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        proc.WaitForExit();

        return proc.ExitCode == 0 && !this.Log.HasLoggedErrors;
    }

    /// <summary>
    /// Parses an MSBuild bool-style property value. Accepts the canonical
    /// <c>"true"</c> / <c>"false"</c> spellings (case-insensitive) and treats
    /// empty / null / unrecognized values as <see langword="false"/>.
    /// </summary>
    private static bool ParseBool(string value) =>
        !string.IsNullOrEmpty(value) && bool.TryParse(value, out var b) && b;
}

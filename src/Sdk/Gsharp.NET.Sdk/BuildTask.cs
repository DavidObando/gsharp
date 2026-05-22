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

    /// <summary>Gets or sets the assembly version stamped on the output.</summary>
    public string Version { get; set; }

    /// <summary>Gets or sets the MSBuild OutputType (Exe / Library).</summary>
    public string OutputType { get; set; }

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
}

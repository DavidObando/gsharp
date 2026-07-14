// <copyright file="PipelineOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.Pipeline;

using System.Collections.Generic;

/// <summary>
/// Whole-run options for a <see cref="MigrationPipeline"/> execution: the
/// optional <c>gsc</c> override, the runs-root output directory, and the build
/// configuration used to discover the default compiler (ADR-0115 §C).
/// </summary>
public sealed class PipelineOptions
{
    /// <summary>
    /// Gets or sets the explicit <c>gsc.dll</c> path. When <see langword="null"/>
    /// the pipeline discovers <c>out/bin/&lt;Config&gt;/Compiler/gsc.dll</c> by
    /// walking up from the working directory.
    /// </summary>
    public string GscPath { get; set; }

    /// <summary>
    /// Gets or sets the explicit <c>gsgen.dll</c> path (issue #2215), forwarded
    /// to gsc via <c>/gsgentool:</c> whenever an app has analyzer references.
    /// When <see langword="null"/> the pipeline discovers
    /// <c>out/bin/&lt;Config&gt;/Gsgen.Cli/gsgen.dll</c> the same way it
    /// discovers <see cref="GscPath"/>.
    /// </summary>
    public string GsgenPath { get; set; }

    /// <summary>
    /// Gets or sets the runs-root directory under which each run writes a
    /// <c>&lt;runId&gt;/</c> subdirectory holding the emitted G#, triage
    /// artifacts, and the run summary JSON.
    /// </summary>
    public string OutputRoot { get; set; }

    /// <summary>Gets or sets the source directory being migrated.</summary>
    public string SourceRoot { get; set; }

    /// <summary>
    /// Gets or sets the build configuration used to locate the default compiler
    /// (<c>Release</c> by default).
    /// </summary>
    public string Config { get; set; } = "Release";

    /// <summary>
    /// Gets or sets a value indicating whether stage 2 compiles the emitted G#
    /// via <c>dotnet build</c> against the locally-built <c>Gsharp.NET.Sdk</c>
    /// instead of invoking <c>gsc</c> directly (issue #2261). The SDK build
    /// runs Roslyn source generators (e.g. CommunityToolkit.Mvvm's
    /// <c>[ObservableProperty]</c>/<c>[RelayCommand]</c>) through its gsgen
    /// MSBuild targets, which the direct-gsc path does not — the dominant
    /// remaining Oahu-migration blocker. Defaults to <see langword="true"/>;
    /// callers can explicitly disable it to use the legacy gsc-direct path.
    /// </summary>
    public bool CompileViaSdk { get; set; } = true;

    /// <summary>
    /// Gets or sets the canonical source-project to generated-project mapping
    /// established before migration starts.
    /// </summary>
    internal IReadOnlyDictionary<string, string> GeneratedProjectPaths { get; set; }
}

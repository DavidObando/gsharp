// <copyright file="PipelineOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.Pipeline;

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
    /// Gets or sets the runs-root directory under which each run writes a
    /// <c>&lt;runId&gt;/</c> subdirectory holding the emitted G#, triage
    /// artifacts, and the run summary JSON.
    /// </summary>
    public string OutputRoot { get; set; }

    /// <summary>
    /// Gets or sets the build configuration used to locate the default compiler
    /// (<c>Release</c> by default).
    /// </summary>
    public string Config { get; set; } = "Release";
}

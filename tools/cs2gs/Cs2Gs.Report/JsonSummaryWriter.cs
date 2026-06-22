// <copyright file="JsonSummaryWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text.Json;
using Cs2Gs.Pipeline;

namespace Cs2Gs.Report;

/// <summary>
/// Serializes a <see cref="ReportModel"/> to <c>summary.json</c> (ADR-0115 §F):
/// the machine-readable run summary — run provenance, per-app/per-stage status,
/// and the gap list keyed by fingerprint with occurrences and merged retry
/// history — for CI consumption and trend tracking. Uses
/// <see cref="TriageSerialization.Options"/> so formatting matches the §D triage
/// artifacts, and ordering is deterministic (apps by id, gaps by fingerprint,
/// stages in execution order), so the same run re-serializes byte-identically.
/// </summary>
public static class JsonSummaryWriter
{
    /// <summary>The summary file name written under the run directory.</summary>
    public const string FileName = "summary.json";

    /// <summary>
    /// Serializes the model to its canonical JSON form.
    /// </summary>
    /// <param name="model">The aggregated report model.</param>
    /// <returns>The deterministic JSON text.</returns>
    public static string Serialize(ReportModel model)
    {
        if (model is null)
        {
            throw new ArgumentNullException(nameof(model));
        }

        return JsonSerializer.Serialize(model, TriageSerialization.Options);
    }

    /// <summary>
    /// Writes <c>summary.json</c> under the run directory and returns its path.
    /// </summary>
    /// <param name="model">The aggregated report model.</param>
    /// <param name="runDir">The run directory to write into.</param>
    /// <returns>The full path of the written file.</returns>
    public static string Write(ReportModel model, string runDir)
    {
        if (string.IsNullOrEmpty(runDir))
        {
            throw new ArgumentException("Run directory is required.", nameof(runDir));
        }

        Directory.CreateDirectory(runDir);
        string path = Path.Combine(runDir, FileName);
        File.WriteAllText(path, Serialize(model));
        return path;
    }
}

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
    /// Writes the JSON summary into <paramref name="outputDir"/> and returns its path.
    /// </summary>
    /// <param name="model">The aggregated report model.</param>
    /// <param name="outputDir">The directory to write into.</param>
    /// <param name="fileName">
    /// The file name to write, defaulting to <see cref="FileName"/> (<c>summary.json</c>)
    /// when <see langword="null"/> or empty. Lets <c>--out &lt;file&gt;</c> honor a
    /// user-supplied summary file name.
    /// </param>
    /// <returns>The full path of the written file.</returns>
    public static string Write(ReportModel model, string outputDir, string fileName = null)
    {
        if (string.IsNullOrEmpty(outputDir))
        {
            throw new ArgumentException("Output directory is required.", nameof(outputDir));
        }

        Directory.CreateDirectory(outputDir);
        string path = Path.Combine(outputDir, string.IsNullOrEmpty(fileName) ? FileName : fileName);
        File.WriteAllText(path, Serialize(model));
        return path;
    }
}

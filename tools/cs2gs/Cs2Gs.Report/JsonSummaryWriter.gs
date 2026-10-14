// <copyright file="JsonSummaryWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Report

import Cs2Gs.Pipeline
import System
import System.IO
import System.Text.Json

/// Serializes a (cref:ReportModel) to `summary.json` (ADR-0115 §F):
/// the machine-readable run summary — run provenance, per-app/per-stage status,
/// and the gap list keyed by fingerprint with occurrences and merged retry
/// history — for CI consumption and trend tracking. Uses
/// (cref:TriageSerialization.Options) so formatting matches the §D triage
/// artifacts, and ordering is deterministic (apps by id, gaps by fingerprint,
/// stages in execution order), so the same run re-serializes byte-identically.
shared class JsonSummaryWriter {
    /// The summary file name written under the run directory.
    const FileName string = "summary.json"

    /// Serializes the model to its canonical JSON form.
    /// @param model The aggregated report model.
    /// @returns The deterministic JSON text.
    func Serialize(model ReportModel?) string {
        if model == nil {
            throw ArgumentNullException("model")
        }
        return JsonSerializer.Serialize(model, TriageSerialization.Options)
    }

    /// Writes the JSON summary into [`outputDir`](paramref) and returns its path.
    /// @param model The aggregated report model.
    /// @param outputDir The directory to write into.
    /// @param fileName The file name to write, defaulting to (cref:FileName) (`summary.json`)
    /// when `null` or empty. Lets `--out <file>` honor a
    /// user-supplied summary file name.
    /// @returns The full path of the written file.
    func Write(model ReportModel, outputDir string, fileName string? = nil) string {
        if string.IsNullOrEmpty(outputDir) {
            throw ArgumentException("Output directory is required.", "outputDir")
        }
        Directory.CreateDirectory(outputDir)
        let path = Path.Combine(
            outputDir,
            if string.IsNullOrEmpty(fileName) {
                FileName
            } else {
                fileName
            }
        )
        File.WriteAllText(path, Serialize(model))
        return path
    }
}

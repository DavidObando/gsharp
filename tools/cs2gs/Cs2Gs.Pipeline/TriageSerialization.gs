// <copyright file="TriageSerialization.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Text.Encodings.Web
import System.Text.Json

/// The canonical (indented, deterministic) JSON serialization settings for
/// triage artifacts and the run summary, plus the schema's stage/category
/// string spellings (ADR-0115 §D.1).
shared class TriageSerialization {
    /// Gets the shared serializer options: indented, camelCase via explicit
    /// `[JsonPropertyName]`, relaxed escaping so snippets stay readable, and
    /// nulls preserved (the schema's source-map sub-fields are nullable). `NewLine`
    /// is pinned to `"\n"` so `summary.json`/`run.json`/triage artifacts are
    /// byte-identical across platforms (ADR-0115 §F) — without this, .NET defaults
    /// `NewLine` to (cref:Environment.NewLine), which is `\r\n` on Windows.
    private let _options JsonSerializerOptions = JsonSerializerOptions{
        WriteIndented: true,
        Encoder: JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        NewLine: "\n"
    }

    prop Options JsonSerializerOptions {
        get {
            return _options
        }
    }

    /// Maps a (cref:MigrationStageKind) to its schema spelling
    /// (`translate`, `compile`, `ilverify`, `test-parity`).
    /// @param kind The stage kind.
    /// @returns The schema stage string.
    func StageName(kind MigrationStageKind) string -> switch kind {
        case MigrationStageKind.Translate: "translate"
        case MigrationStageKind.Compile: "compile"
        case MigrationStageKind.IlVerify: "ilverify"
        case MigrationStageKind.TestParity: "test-parity"
        default: throw ArgumentOutOfRangeException("kind")
    }

    /// Parses a schema stage string (the inverse of (cref:StageName)).
    /// @param name The stage string, e.g. `compile`.
    /// @param kind The parsed stage.
    /// @returns `true` when [`name`](paramref) names a stage.
    func TryParseStageName(name string, out kind MigrationStageKind) bool {
        for candidate in Enum.GetValues[MigrationStageKind]() {
            if string.Equals(StageName(candidate), name, StringComparison.Ordinal) {
                kind = candidate
                return true
            }
        }
        kind = default(MigrationStageKind)
        return false
    }

    /// Maps a (cref:TriageCategory) to its schema spelling
    /// (`translation-unsupported`, `compile-error`, `pipeline-crash`, …).
    /// @param category The triage category.
    /// @returns The schema category string.
    func CategoryName(category TriageCategory) string -> switch category {
        case TriageCategory.TranslationUnsupported: "translation-unsupported"
        case TriageCategory.CompileError: "compile-error"
        case TriageCategory.IlVerifyFailure: "ilverify-failure"
        case TriageCategory.TestParityFailure: "test-parity-failure"
        case TriageCategory.PipelineCrash: "pipeline-crash"
        default: throw ArgumentOutOfRangeException("category")
    }
}

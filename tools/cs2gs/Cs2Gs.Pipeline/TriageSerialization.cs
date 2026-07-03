// <copyright file="TriageSerialization.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The canonical (indented, deterministic) JSON serialization settings for
/// triage artifacts and the run summary, plus the schema's stage/category
/// string spellings (ADR-0115 §D.1).
/// </summary>
public static class TriageSerialization
{
    /// <summary>
    /// Gets the shared serializer options: indented, camelCase via explicit
    /// <c>[JsonPropertyName]</c>, relaxed escaping so snippets stay readable, and
    /// nulls preserved (the schema's source-map sub-fields are nullable). <c>NewLine</c>
    /// is pinned to <c>"\n"</c> so <c>summary.json</c>/<c>run.json</c>/triage artifacts are
    /// byte-identical across platforms (ADR-0115 §F) — without this, .NET defaults
    /// <c>NewLine</c> to <see cref="Environment.NewLine"/>, which is <c>\r\n</c> on Windows.
    /// </summary>
    public static JsonSerializerOptions Options { get; } = new JsonSerializerOptions
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        NewLine = "\n",
    };

    /// <summary>
    /// Maps a <see cref="MigrationStageKind"/> to its schema spelling
    /// (<c>translate</c>, <c>compile</c>, <c>ilverify</c>, <c>test-parity</c>).
    /// </summary>
    /// <param name="kind">The stage kind.</param>
    /// <returns>The schema stage string.</returns>
    public static string StageName(MigrationStageKind kind) => kind switch
    {
        MigrationStageKind.Translate => "translate",
        MigrationStageKind.Compile => "compile",
        MigrationStageKind.IlVerify => "ilverify",
        MigrationStageKind.TestParity => "test-parity",
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    /// <summary>
    /// Maps a <see cref="TriageCategory"/> to its schema spelling
    /// (<c>translation-unsupported</c>, <c>compile-error</c>, …).
    /// </summary>
    /// <param name="category">The triage category.</param>
    /// <returns>The schema category string.</returns>
    public static string CategoryName(TriageCategory category) => category switch
    {
        TriageCategory.TranslationUnsupported => "translation-unsupported",
        TriageCategory.CompileError => "compile-error",
        TriageCategory.IlVerifyFailure => "ilverify-failure",
        TriageCategory.TestParityFailure => "test-parity-failure",
        _ => throw new ArgumentOutOfRangeException(nameof(category)),
    };
}

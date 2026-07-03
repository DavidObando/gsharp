// <copyright file="ConstructEntry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Text.Json.Serialization;

namespace Cs2Gs.Translator.Coverage;

/// <summary>
/// One row of the construct inventory: a C# node kind and its recorded
/// translation disposition.
/// </summary>
public sealed class ConstructEntry
{
    /// <summary>Gets or sets the Roslyn <c>SyntaxKind</c> name (the inventory key).</summary>
    [JsonPropertyName("kind")]
    public string Kind { get; set; }

    /// <summary>Gets or sets the concrete Roslyn node-class name serving this kind.</summary>
    [JsonPropertyName("nodeType")]
    public string NodeType { get; set; }

    /// <summary>Gets or sets the translation disposition.</summary>
    [JsonPropertyName("status")]
    [JsonConverter(typeof(JsonStringEnumConverter<ConstructStatus>))]
    public ConstructStatus Status { get; set; }

    /// <summary>Gets or sets the canonical-rule reference (e.g. "ADR-0115 §B.16"); required when translated/lowered.</summary>
    [JsonPropertyName("rule")]
    public string Rule { get; set; }

    /// <summary>Gets or sets the rationale; required when unsupported-by-design.</summary>
    [JsonPropertyName("rationale")]
    [JsonConverter(typeof(JsonStringEnumConverter<UnsupportedRationale>))]
    public UnsupportedRationale Rationale { get; set; }

    /// <summary>Gets or sets the repo-relative fixture path exercising the construct, when one exists.</summary>
    [JsonPropertyName("fixture")]
    public string Fixture { get; set; }

    /// <summary>Gets or sets the tracking GitHub issue URL; required when the status is gap or the rationale is deferred.</summary>
    [JsonPropertyName("issue")]
    public string Issue { get; set; }

    /// <summary>Gets or sets free-form notes (e.g. sub-cases, contested-classification arbitration).</summary>
    [JsonPropertyName("notes")]
    public string Notes { get; set; }
}

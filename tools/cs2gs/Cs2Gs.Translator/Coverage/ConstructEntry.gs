// <copyright file="ConstructEntry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Coverage

import System.Text.Json.Serialization

/// One row of the construct inventory: a C# node kind and its recorded
/// translation disposition.
class ConstructEntry {
    /// Gets or sets the Roslyn `SyntaxKind` name (the inventory key).
    @JsonPropertyName("kind")
    prop Kind string

    /// Gets or sets the concrete Roslyn node-class name serving this kind.
    @JsonPropertyName("nodeType")
    prop NodeType string

    /// Gets or sets the translation disposition.
    @JsonPropertyName("status")
    @JsonConverter(typeof(JsonStringEnumConverter[ConstructStatus]))
    prop Status ConstructStatus

    /// Gets or sets the canonical-rule reference (e.g. "ADR-0115 §B.16"); required when translated/lowered.
    @JsonPropertyName("rule")
    prop Rule string

    /// Gets or sets the rationale; required when unsupported-by-design.
    @JsonPropertyName("rationale")
    @JsonConverter(typeof(JsonStringEnumConverter[UnsupportedRationale]))
    prop Rationale UnsupportedRationale

    /// Gets or sets the repo-relative fixture path exercising the construct, when one exists.
    @JsonPropertyName("fixture")
    prop Fixture string

    /// Gets or sets the tracking GitHub issue URL; required when the status is gap or the rationale is
    /// deferred.
    @JsonPropertyName("issue")
    prop Issue string

    /// Gets or sets free-form notes (e.g. sub-cases, contested-classification arbitration).
    @JsonPropertyName("notes")
    prop Notes string
}

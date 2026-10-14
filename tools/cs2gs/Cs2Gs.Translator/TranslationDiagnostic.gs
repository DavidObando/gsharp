// <copyright file="TranslationDiagnostic.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.Translator.Coverage
import Microsoft.CodeAnalysis

/// The severity of a (cref:TranslationDiagnostic).
enum TranslationSeverity {
    Info,
    Warning,
    Unsupported
}

/// Whether an (cref:TranslationSeverity.Unsupported) diagnostic is a
/// recorded design decision or an accidental fallthrough (ADR-0138). The
/// choke point in (cref:TranslationContext.ReportUnsupported) assigns
/// it from the (cref:UnsupportedByDesign) registry.
enum UnsupportedClassification {
    Gap,
    ByDesign
}

/// A structured record of a C# construct the translator could not (yet) map to
/// canonical G#. The translator <b>never silently drops</b> a construct
/// (ADR-0115 §B): every unmapped node produces one of these so the pipeline can
/// triage the gap. This is the seam that steps 6–8 progressively shrink.
class TranslationDiagnostic {
    /// Initializes a new instance of the (cref:TranslationDiagnostic) class.
    /// @param constructKind The C# construct kind (e.g. the syntax-kind name).
    /// @param message A human-readable description of the gap.
    /// @param location The C# source location, or `null` if unknown.
    /// @param severity The severity; defaults to (cref:TranslationSeverity.Unsupported).
    init(
        constructKind string,
        message string?,
        location Location? = nil,
        severity TranslationSeverity = TranslationSeverity.Unsupported
    ) {
        this.ConstructKind = constructKind
        this.Message = message
        this.Location = location
        this.Severity = severity
    }

    /// Gets the C# construct kind (e.g. the syntax-kind name).
    prop ConstructKind string {
        get;
    }

    /// Gets the human-readable description of the gap.
    prop Message string? {
        get;
    }

    /// Gets the C# source location, or `null` if unknown.
    prop Location Location? {
        get;
    }

    /// Gets the severity.
    prop Severity TranslationSeverity {
        get;
    }

    /// Gets or sets the gap-vs-by-design classification of an
    /// (cref:TranslationSeverity.Unsupported) record. Defaults to
    /// (cref:UnsupportedClassification.Gap); the
    /// (cref:TranslationContext.ReportUnsupported) choke point upgrades
    /// it when the construct is in the (cref:UnsupportedByDesign) registry.
    prop Classification UnsupportedClassification

    /// Gets or sets the rationale when (cref:Classification) is
    /// (cref:UnsupportedClassification.ByDesign).
    prop Rationale UnsupportedRationale

    /// Gets or sets an explicit diagnostic id overriding the classification-
    /// derived `CS2GS-GAP`/`CS2GS-UNSUPPORTED` pair — e.g.
    /// `CS2GS-ANALYZER-SHAPE` for analyzer-mode adapted rewrites
    /// (ADR-0169). Null keeps the classification-derived id.
    prop DiagnosticId string?

    /// Gets a value indicating whether this is an unsupported-construct record.
    prop IsUnsupported bool -> this.Severity == TranslationSeverity.Unsupported

    /// Renders a single-line, deterministic description of the diagnostic
    /// including the source position when available.
    /// @returns The formatted diagnostic text.
    override func ToString() string {
        if this.Location is {} loc && loc.IsInSource {
            let span = loc.GetLineSpan()
            let line = span.StartLinePosition.Line + 1
            let column = span.StartLinePosition.Character + 1
            return "${span.Path}($line,$column): ${this.Severity.ToString().ToLowerInvariant()}: " +
                "${this.ConstructKind}: ${this.Message}"
        }
        return "${this.Severity.ToString().ToLowerInvariant()}: ${this.ConstructKind}: ${this.Message}"
    }
}

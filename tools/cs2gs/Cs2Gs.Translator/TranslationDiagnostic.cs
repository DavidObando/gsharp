// <copyright file="TranslationDiagnostic.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;

namespace Cs2Gs.Translator;

/// <summary>
/// The severity of a <see cref="TranslationDiagnostic"/>.
/// </summary>
public enum TranslationSeverity
{
    /// <summary>An informational note that does not block translation.</summary>
    Info,

    /// <summary>A construct translated with a caveat the human should review.</summary>
    Warning,

    /// <summary>
    /// A C# construct with no established canonical G# form, or not yet
    /// implemented; the Translate stage treats this as a gate failure
    /// (ADR-0115 §B/§C — category <c>translation-unsupported</c>).
    /// </summary>
    Unsupported,
}

/// <summary>
/// A structured record of a C# construct the translator could not (yet) map to
/// canonical G#. The translator <b>never silently drops</b> a construct
/// (ADR-0115 §B): every unmapped node produces one of these so the pipeline can
/// triage the gap. This is the seam that steps 6–8 progressively shrink.
/// </summary>
public sealed class TranslationDiagnostic
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TranslationDiagnostic"/> class.
    /// </summary>
    /// <param name="constructKind">The C# construct kind (e.g. the syntax-kind name).</param>
    /// <param name="message">A human-readable description of the gap.</param>
    /// <param name="location">The C# source location, or <see langword="null"/> if unknown.</param>
    /// <param name="severity">The severity; defaults to <see cref="TranslationSeverity.Unsupported"/>.</param>
    public TranslationDiagnostic(
        string constructKind,
        string message,
        Location location = null,
        TranslationSeverity severity = TranslationSeverity.Unsupported)
    {
        this.ConstructKind = constructKind;
        this.Message = message;
        this.Location = location;
        this.Severity = severity;
    }

    /// <summary>Gets the C# construct kind (e.g. the syntax-kind name).</summary>
    public string ConstructKind { get; }

    /// <summary>Gets the human-readable description of the gap.</summary>
    public string Message { get; }

    /// <summary>Gets the C# source location, or <see langword="null"/> if unknown.</summary>
    public Location Location { get; }

    /// <summary>Gets the severity.</summary>
    public TranslationSeverity Severity { get; }

    /// <summary>Gets a value indicating whether this is an unsupported-construct record.</summary>
    public bool IsUnsupported => this.Severity == TranslationSeverity.Unsupported;

    /// <summary>
    /// Renders a single-line, deterministic description of the diagnostic
    /// including the source position when available.
    /// </summary>
    /// <returns>The formatted diagnostic text.</returns>
    public override string ToString()
    {
        if (this.Location is { } loc && loc.IsInSource)
        {
            FileLinePositionSpan span = loc.GetLineSpan();
            int line = span.StartLinePosition.Line + 1;
            int column = span.StartLinePosition.Character + 1;
            return $"{span.Path}({line},{column}): {this.Severity.ToString().ToLowerInvariant()}: " +
                $"{this.ConstructKind}: {this.Message}";
        }

        return $"{this.Severity.ToString().ToLowerInvariant()}: {this.ConstructKind}: {this.Message}";
    }
}

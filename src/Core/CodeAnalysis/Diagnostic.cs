// <copyright file="Diagnostic.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Code analysis diagnostic information.
/// </summary>
public sealed class Diagnostic
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Diagnostic"/> class.
    /// </summary>
    /// <param name="location">Text location in the document where this diagnostic information originates from.</param>
    /// <param name="id">The stable diagnostic identifier (e.g. <c>GS0001</c>).</param>
    /// <param name="severity">The severity of the diagnostic.</param>
    /// <param name="message">Diagnostic information message.</param>
    public Diagnostic(TextLocation location, string id, DiagnosticSeverity severity, string message)
    {
        Location = location;
        Id = id;
        Severity = severity;
        Message = message;
        AdditionalLocations = ImmutableArray<TextLocation>.Empty;
        Properties = ImmutableDictionary<string, string?>.Empty;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="Diagnostic"/> class with
    /// a default severity of <see cref="DiagnosticSeverity.Error"/> and no
    /// stable identifier. Provided for backward compatibility.
    /// </summary>
    /// <param name="location">Text location in the document where this diagnostic information originates from.</param>
    /// <param name="message">Diagnostic information message.</param>
    public Diagnostic(TextLocation location, string message)
        : this(location, "GS0000", DiagnosticSeverity.Error, message)
    {
    }

    private Diagnostic(
        DiagnosticDescriptor descriptor,
        TextLocation location,
        DiagnosticSeverity severity,
        string message,
        ImmutableArray<TextLocation> additionalLocations,
        ImmutableDictionary<string, string?> properties)
    {
        Descriptor = descriptor;
        Location = location;
        Id = descriptor.Id;
        Severity = severity;
        Message = message;
        AdditionalLocations = additionalLocations;
        Properties = properties;
    }

    /// <summary>
    /// Gets the stable diagnostic identifier (e.g. <c>GS0001</c>).
    /// </summary>
    public string Id { get; }

    /// <summary>
    /// Gets the severity of this diagnostic.
    /// </summary>
    public DiagnosticSeverity Severity { get; }

    /// <summary>
    /// Gets the text location in the document where this diagnostic information originates from.
    /// </summary>
    public TextLocation Location { get; }

    /// <summary>
    /// Gets the diagnostic information message.
    /// </summary>
    public string Message { get; }

    /// <summary>
    /// Gets the descriptor this diagnostic was created from, or <see langword="null"/>
    /// for diagnostics produced through the pre-ADR-0169 constructor paths.
    /// </summary>
    public DiagnosticDescriptor? Descriptor { get; }

    /// <summary>
    /// Gets locations related to the diagnostic beyond its primary
    /// <see cref="Location"/> (e.g. the other declaration in a duplicate
    /// definition). Empty for most diagnostics.
    /// </summary>
    public ImmutableArray<TextLocation> AdditionalLocations { get; }

    /// <summary>
    /// Gets an immutable property bag attached by the producer, consumed by
    /// tooling such as code fixes. Empty for most diagnostics.
    /// </summary>
    public ImmutableDictionary<string, string?> Properties { get; }

    /// <summary>
    /// Gets a value indicating whether this diagnostic is an error.
    /// </summary>
    public bool IsError => Severity == DiagnosticSeverity.Error;

    /// <summary>
    /// Creates a diagnostic from a descriptor, formatting the descriptor's
    /// message template with <paramref name="messageArguments"/> and using the
    /// descriptor's default severity.
    /// </summary>
    /// <param name="descriptor">The rule the diagnostic instantiates.</param>
    /// <param name="location">The primary location of the diagnostic.</param>
    /// <param name="messageArguments">Arguments for the descriptor's message template.</param>
    /// <returns>The created diagnostic.</returns>
    public static Diagnostic Create(
        DiagnosticDescriptor descriptor,
        TextLocation location,
        params object?[] messageArguments)
        => Create(descriptor, location, ImmutableArray<TextLocation>.Empty, ImmutableDictionary<string, string?>.Empty, messageArguments);

    /// <summary>
    /// Creates a diagnostic from a descriptor with additional locations and a
    /// property bag.
    /// </summary>
    /// <param name="descriptor">The rule the diagnostic instantiates.</param>
    /// <param name="location">The primary location of the diagnostic.</param>
    /// <param name="additionalLocations">Locations related to the diagnostic beyond the primary one.</param>
    /// <param name="properties">A property bag for tooling; <see langword="default"/> means empty.</param>
    /// <param name="messageArguments">Arguments for the descriptor's message template.</param>
    /// <returns>The created diagnostic.</returns>
    public static Diagnostic Create(
        DiagnosticDescriptor descriptor,
        TextLocation location,
        ImmutableArray<TextLocation> additionalLocations,
        ImmutableDictionary<string, string?>? properties,
        params object?[] messageArguments)
    {
        var message = messageArguments is { Length: > 0 }
            ? string.Format(descriptor.MessageFormat, messageArguments)
            : descriptor.MessageFormat;
        return new Diagnostic(
            descriptor,
            location,
            descriptor.DefaultSeverity,
            message,
            additionalLocations.IsDefault ? ImmutableArray<TextLocation>.Empty : additionalLocations,
            properties ?? ImmutableDictionary<string, string?>.Empty);
    }

    /// <summary>
    /// Returns a copy of this diagnostic with the given effective severity,
    /// preserving all other data. Used by severity configuration
    /// (<c>/gsdiag:</c>, <c>/warnaserror</c>).
    /// </summary>
    /// <param name="severity">The effective severity for the copy.</param>
    /// <returns>A diagnostic identical to this one except for its severity.</returns>
    public Diagnostic WithSeverity(DiagnosticSeverity severity)
    {
        if (severity == Severity)
        {
            return this;
        }

        return Descriptor is { } descriptor
            ? new Diagnostic(descriptor, Location, severity, Message, AdditionalLocations, Properties)
            : new Diagnostic(Location, Id, severity, Message);
    }

    /// <summary>
    /// Diagnostic information message.
    /// </summary>
    /// <returns>A string with the message.</returns>
    public override string ToString() => Message;
}

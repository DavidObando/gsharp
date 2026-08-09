// <copyright file="Diagnostic.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
    /// Gets a value indicating whether this diagnostic is an error.
    /// </summary>
    public bool IsError => Severity == DiagnosticSeverity.Error;

    /// <summary>
    /// Diagnostic information message.
    /// </summary>
    /// <returns>A string with the message.</returns>
    public override string ToString() => Message;
}

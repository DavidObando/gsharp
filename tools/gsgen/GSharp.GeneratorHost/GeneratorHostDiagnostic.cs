// <copyright file="GeneratorHostDiagnostic.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.GeneratorHost;

/// <summary>
/// A diagnostic the generator host itself reports (not a generator's), with
/// the user-source location it concerns.
/// </summary>
public sealed class GeneratorHostDiagnostic
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GeneratorHostDiagnostic"/> class.
    /// </summary>
    /// <param name="id">The diagnostic id.</param>
    /// <param name="message">The message.</param>
    /// <param name="location">The G# source location.</param>
    public GeneratorHostDiagnostic(string id, string message, TextLocation location)
    {
        Id = id;
        Message = message;
        Location = location;
    }

    /// <summary>Gets the diagnostic id.</summary>
    public string Id { get; }

    /// <summary>Gets the message.</summary>
    public string Message { get; }

    /// <summary>Gets the G# source location.</summary>
    public TextLocation Location { get; }
}

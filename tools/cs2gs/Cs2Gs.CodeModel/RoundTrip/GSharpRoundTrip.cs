// <copyright file="GSharpRoundTrip.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;

namespace Cs2Gs.CodeModel.RoundTrip;

/// <summary>
/// Parses canonical G# source with the real G# parser and reports
/// error-severity diagnostics, proving emitted text re-parses.
/// </summary>
public static class GSharpRoundTrip
{
    /// <summary>
    /// Validates that the supplied G# source parses with no error diagnostics.
    /// </summary>
    /// <param name="gsharpSource">The G# source text to validate.</param>
    /// <returns>The validation result.</returns>
    public static RoundTripResult Validate(string gsharpSource)
    {
        var tree = SyntaxTree.Parse(gsharpSource ?? string.Empty);
        var errors = tree.Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.Message}")
            .ToList();
        return new RoundTripResult(errors);
    }
}

/// <summary>
/// The outcome of a <see cref="GSharpRoundTrip.Validate"/> call.
/// </summary>
public sealed class RoundTripResult
{
    /// <summary>
    /// Initializes a new instance of the <see cref="RoundTripResult"/> class.
    /// </summary>
    /// <param name="errors">The error-severity diagnostics, formatted as text.</param>
    public RoundTripResult(IReadOnlyList<string> errors)
    {
        Errors = errors ?? new List<string>();
    }

    /// <summary>
    /// Gets a value indicating whether the source parsed without errors.
    /// </summary>
    public bool Success => Errors.Count == 0;

    /// <summary>
    /// Gets the error-severity diagnostics produced while parsing.
    /// </summary>
    public IReadOnlyList<string> Errors { get; }
}

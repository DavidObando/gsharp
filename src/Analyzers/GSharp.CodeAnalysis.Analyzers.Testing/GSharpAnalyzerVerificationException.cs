// <copyright file="GSharpAnalyzerVerificationException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.CodeAnalysis.Analyzers.Testing;

/// <summary>
/// Thrown by <see cref="GSharpAnalyzerVerifier{TAnalyzer}"/> when the analyzer
/// under test produced different diagnostics than the marked source expects.
/// Framework-agnostic so the verifier works under any test runner.
/// </summary>
public sealed class GSharpAnalyzerVerificationException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GSharpAnalyzerVerificationException"/> class.
    /// </summary>
    /// <param name="message">The verification failure description.</param>
    public GSharpAnalyzerVerificationException(string message)
        : base(message)
    {
    }
}

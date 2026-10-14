// <copyright file="GSharpAnalyzerVerificationException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.CodeAnalysis.Analyzers.Testing

import System

/// Thrown by (cref:GSharpAnalyzerVerifier{TAnalyzer}) when the analyzer
/// under test produced different diagnostics than the marked source expects.
/// Framework-agnostic so the verifier works under any test runner.
class GSharpAnalyzerVerificationException : Exception {
    /// Initializes a new instance of the (cref:GSharpAnalyzerVerificationException) class.
    /// @param message The verification failure description.
    init(message string) : base(message) { }
}

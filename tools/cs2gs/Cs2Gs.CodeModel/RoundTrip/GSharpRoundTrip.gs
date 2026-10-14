// <copyright file="GSharpRoundTrip.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.RoundTrip

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq

/// Parses canonical G# source with the real G# parser and reports
/// error-severity diagnostics, proving emitted text re-parses.
shared class GSharpRoundTrip {
    /// Validates that the supplied G# source parses with no error diagnostics.
    /// @param gsharpSource The G# source text to validate.
    /// @returns The validation result.
    func Validate(gsharpSource string) RoundTripResult {
        let tree = SyntaxTree.Parse(gsharpSource ?? string.Empty)
        let errors = tree
            .Diagnostics
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .Select((d Diagnostic) -> "${d.Id}: ${d.Message}")
            .ToList()
        return RoundTripResult(errors)
    }
}

/// The outcome of a (cref:GSharpRoundTrip.Validate) call.
class RoundTripResult {
    /// Initializes a new instance of the (cref:RoundTripResult) class.
    /// @param errors The error-severity diagnostics, formatted as text.
    init(errors IReadOnlyList[string]) {
        Errors = errors ?? List[string]()
    }

    /// Gets a value indicating whether the source parsed without errors.
    prop Success bool -> Errors.Count == 0

    /// Gets the error-severity diagnostics produced while parsing.
    prop Errors IReadOnlyList[string] {
        get;
    }
}

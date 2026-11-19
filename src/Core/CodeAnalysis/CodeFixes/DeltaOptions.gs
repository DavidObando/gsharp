// <copyright file="DeltaOptions.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import System
import System.Collections.Immutable

/// The options of a diagnostic-delta check (ADR-0227 D4).
class DeltaOptions {
    private var analyzers ImmutableArray[GSharpDiagnosticAnalyzer] = ImmutableArray[GSharpDiagnosticAnalyzer].Empty
    private var stopOnNewSyntaxError bool = true

    /// Initializes a new instance of the (cref:DeltaOptions) class with the defaults.
    init() { }

    // A copy, so a baseline keeps the options that it was computed with.
    internal func Snapshot() DeltaOptions {
        let copy = DeltaOptions()
        copy.Analyzers = Analyzers
        copy.StopOnNewSyntaxError = StopOnNewSyntaxError
        copy.DiagnosticFilter = DiagnosticFilter
        return copy
    }

    /// Gets or sets the analyzers that run before and after the edit. The default is none.
    prop Analyzers ImmutableArray[GSharpDiagnosticAnalyzer] {
        get -> analyzers
        set -> analyzers = if value.IsDefault {
            ImmutableArray[GSharpDiagnosticAnalyzer].Empty
        } else {
            value
        }
    }

    /// Gets or sets a value that tells whether the check stops after the parse when the edit adds a
    /// syntax diagnostic. The default is `true`.
    prop StopOnNewSyntaxError bool {
        get -> stopOnNewSyntaxError
        set -> stopOnNewSyntaxError = value
    }

    /// Gets or sets the host's severity policy (`/nowarn`, `/warnaserror`). The service applies it
    /// to every diagnostic before and after. It returns the diagnostic with its effective
    /// severity, or `null` to drop it. `null` keeps every diagnostic as it is.
    prop DiagnosticFilter Func[Diagnostic, Diagnostic?]?
}

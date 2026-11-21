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
    private var bodyLocalBind bool = true

    /// Initializes a new instance of the (cref:DeltaOptions) class with the defaults.
    init() { }

    // A copy, so a baseline keeps the options that it was computed with.
    internal func Snapshot() DeltaOptions {
        let copy = DeltaOptions()
        copy.Analyzers = Analyzers
        copy.StopOnNewSyntaxError = StopOnNewSyntaxError
        copy.DiagnosticFilter = DiagnosticFilter
        copy.SyntaxOnly = SyntaxOnly
        copy.BodyLocalBind = BodyLocalBind
        // AnalyzerOptions is mutable, so the snapshot gets its own copy.
        let analyzerOptions AnalyzerOptions? = AnalyzerOptions
        copy.AnalyzerOptions = if analyzerOptions == nil {
            default(AnalyzerOptions?)
        } else {
            AnalyzerOptions{TimeBudgetMilliseconds: analyzerOptions.TimeBudgetMilliseconds}
        }
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

    /// Gets or sets a value that tells whether the check binds only the edited function body when
    /// the edit is confined to one (ADR-0227 D4). The result is the result of the full check: the
    /// check binds the whole compilation whenever the edit can change what anything outside the
    /// body reports, and whenever (cref:Analyzers) is not empty. The default is `true`.
    prop BodyLocalBind bool {
        get -> bodyLocalBind
        set -> bodyLocalBind = value
    }

    /// Gets or sets the options of the analyzer driver, such as a time budget for each analyzer.
    /// `null` uses the driver's defaults.
    prop AnalyzerOptions AnalyzerOptions?

    /// Gets or sets a value that tells whether the check stops after the parse in every case: it
    /// compares only the syntax diagnostics of the changed documents and never binds. An
    /// interactive host uses it as a cheap gate. The default is `false`.
    prop SyntaxOnly bool

    /// Gets or sets the host's severity policy (`/nowarn`, `/warnaserror`). The service applies it
    /// to every diagnostic before and after. It returns the diagnostic with its effective
    /// severity, or `null` to drop it. `null` keeps every diagnostic as it is.
    prop DiagnosticFilter Func[Diagnostic, Diagnostic?]?
}

// <copyright file="CompilationAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import System
import System.Threading

/// The context passed to compilation and compilation-end actions (Roslyn's
/// `CompilationAnalysisContext`).
struct CompilationAnalysisContext {
    private let reportDiagnostic(Diagnostic) -> void

    internal init(compilation Compilation, reportDiagnostic(Diagnostic) -> void, cancellationToken CancellationToken) {
        Compilation = compilation
        this.reportDiagnostic = reportDiagnostic
        CancellationToken = cancellationToken
    }

    /// Gets the compilation being analyzed.
    prop Compilation Compilation {
        get;
    }

    /// Gets the token that cancels the analysis run.
    prop CancellationToken CancellationToken {
        get;
    }

    /// Reports a diagnostic. The diagnostic's ID must be declared in the
    /// reporting analyzer's SupportedDiagnostics.
    /// @param diagnostic The diagnostic to report.
    func ReportDiagnostic(diagnostic Diagnostic) -> reportDiagnostic(diagnostic)
}

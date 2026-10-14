// <copyright file="SemanticModelAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import System
import System.Threading

/// The context passed to semantic-model actions: once per tree, after
/// binding (Roslyn's `SemanticModelAnalysisContext`).
struct SemanticModelAnalysisContext {
    private let reportDiagnostic(Diagnostic) -> void

    internal init(
        semanticModel SemanticModel,
        reportDiagnostic(Diagnostic) -> void,
        cancellationToken CancellationToken
    ) {
        SemanticModel = semanticModel
        this.reportDiagnostic = reportDiagnostic
        CancellationToken = cancellationToken
    }

    /// Gets the semantic model for the tree being analyzed.
    prop SemanticModel SemanticModel {
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

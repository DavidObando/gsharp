// <copyright file="SyntaxNodeAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Threading

/// The context passed to syntax-node actions (Roslyn's
/// `SyntaxNodeAnalysisContext`).
struct SyntaxNodeAnalysisContext {
    private let reportDiagnostic(Diagnostic) -> void

    internal init(
        node SyntaxNode,
        semanticModel SemanticModel,
        reportDiagnostic(Diagnostic) -> void,
        cancellationToken CancellationToken
    ) {
        Node = node
        SemanticModel = semanticModel
        this.reportDiagnostic = reportDiagnostic
        CancellationToken = cancellationToken
    }

    /// Gets the node being analyzed.
    prop Node SyntaxNode {
        get;
    }

    /// Gets the semantic model for the node's tree.
    prop SemanticModel SemanticModel {
        get;
    }

    /// Gets the compilation being analyzed.
    prop Compilation Compilation -> SemanticModel.Compilation

    /// Gets the token that cancels the analysis run.
    prop CancellationToken CancellationToken {
        get;
    }

    /// Reports a diagnostic. The diagnostic's ID must be declared in the
    /// reporting analyzer's SupportedDiagnostics.
    /// @param diagnostic The diagnostic to report.
    func ReportDiagnostic(diagnostic Diagnostic) -> reportDiagnostic(diagnostic)
}

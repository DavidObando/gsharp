// <copyright file="SyntaxTreeAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Threading

/// The context passed to syntax-tree actions (parse-level; no semantics).
struct SyntaxTreeAnalysisContext {
    private let reportDiagnostic(Diagnostic) -> void

    internal init(tree SyntaxTree, reportDiagnostic(Diagnostic) -> void, cancellationToken CancellationToken) {
        Tree = tree
        this.reportDiagnostic = reportDiagnostic
        CancellationToken = cancellationToken
    }

    /// Gets the syntax tree being analyzed.
    prop Tree SyntaxTree {
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

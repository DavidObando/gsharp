// <copyright file="BoundNodeAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Threading

/// The context passed to bound-node actions — the counterpart of Roslyn's
/// `OperationAnalysisContext`, with (cref:BoundNode) standing in
/// for `IOperation` (ADR-0169). (cref:BoundNode.Syntax) may be
/// null for synthesized nodes; report locations against the nearest anchored
/// ancestor via (cref:ContainingFunction) when it is.
struct BoundNodeAnalysisContext {
    private let reportDiagnostic(Diagnostic) -> void

    internal init(
        boundNode BoundNode,
        containingFunction FunctionSymbol?,
        compilation Compilation,
        reportDiagnostic(Diagnostic) -> void,
        cancellationToken CancellationToken
    ) {
        BoundNode = boundNode
        ContainingFunction = containingFunction
        Compilation = compilation
        this.reportDiagnostic = reportDiagnostic
        CancellationToken = cancellationToken
    }

    /// Gets the bound node being analyzed.
    prop BoundNode BoundNode {
        get;
    }

    /// Gets the function whose body contains the node. Top-level statements
    /// use their synthesized entry-point function when the compilation has one;
    /// otherwise this is null.
    prop ContainingFunction FunctionSymbol? {
        get;
    }

    /// Gets the function whose body contains the node as a
    /// (cref:Symbol) — the Roslyn `ContainingSymbol` analogue.
    prop ContainingSymbol Symbol? -> ContainingFunction

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

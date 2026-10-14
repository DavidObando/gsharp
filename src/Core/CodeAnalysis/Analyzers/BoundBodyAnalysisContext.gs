// <copyright file="BoundBodyAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Threading

/// The context passed to bound-body actions — the counterpart of Roslyn's
/// `OperationBlockAnalysisContext` (ADR-0169, issue #4436). A body
/// action runs once per declared function body and sees the whole bound
/// body at once, so a rule can relate nodes to each other (a local's
/// initializer to its later uses, say) without walking up a parent chain,
/// which bound nodes do not have.
/// @remarks Function literals and local functions are bound inside the body that
/// declares them, so they are part of that body, as they are part of their
/// containing method's operation block in Roslyn. A field's initializer is a
/// body of its own, owned by the field, as a Roslyn field-initializer block
/// is. Top-level statements have no owning symbol and are not dispatched to
/// body actions.
struct BoundBodyAnalysisContext {
    private let reportDiagnostic(Diagnostic) -> void

    internal init(
        owningSymbol Symbol,
        body BoundNode,
        compilation Compilation,
        reportDiagnostic(Diagnostic) -> void,
        cancellationToken CancellationToken
    ) {
        OwningSymbol = owningSymbol
        Bodies = ImmutableArray.Create(body)
        Compilation = compilation
        this.reportDiagnostic = reportDiagnostic
        CancellationToken = cancellationToken
    }

    /// Gets the function whose body is being analyzed, or
    /// `null` for a field initializer.
    prop OwningFunction FunctionSymbol? -> OwningSymbol as FunctionSymbol

    /// Gets the member that owns the body — the Roslyn `OwningSymbol`
    /// analogue: a function, or a field for its initializer.
    prop OwningSymbol Symbol {
        get;
    }

    /// Gets the bound body — the Roslyn `OperationBlocks` analogue. A G#
    /// function has one body, and a field one initializer, so this always has
    /// exactly one element.
    prop Bodies ImmutableArray[BoundNode] {
        get;
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

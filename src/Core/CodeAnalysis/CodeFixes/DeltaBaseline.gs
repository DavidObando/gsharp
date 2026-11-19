// <copyright file="DeltaBaseline.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
import System
import System.Collections.Immutable
import System.Threading

/// The diagnostics of a compilation before an edit, computed once and shared by the delta checks
/// of one request (ADR-0227 D4).
class DeltaBaseline {
    internal init(compilation Compilation, options DeltaOptions, diagnostics ImmutableArray[Diagnostic]) {
        Compilation = compilation
        Options = options
        Diagnostics = diagnostics
    }

    /// Gets the compilation before the edit.
    prop Compilation Compilation {
        get;
    }

    /// Gets the options of the checks.
    prop Options DeltaOptions {
        get;
    }

    /// Gets the diagnostics before the edit, after the host's filter, in compilation order and then analyzer order.
    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }

    shared {
        // Tests build a baseline from given diagnostics, for example with another severity policy.
        internal func CreateForTest(
            compilation Compilation,
            options DeltaOptions,
            diagnostics ImmutableArray[Diagnostic]
        ) DeltaBaseline -> DeltaBaseline(compilation, options, diagnostics)

        /// Computes the diagnostics of [`compilation`](paramref) and of the analyzers of [`options`](paramref).
        /// @param compilation The compilation before the edit. It is not changed.
        /// @param options The options of the checks.
        /// @param cancellationToken Cancels the wait for the compilation's diagnostics and the analyzers.
        /// @returns The baseline.
        func Create(
            compilation Compilation,
            options DeltaOptions? = nil,
            cancellationToken CancellationToken = default(CancellationToken)
        ) DeltaBaseline {
            ArgumentNullException.ThrowIfNull(compilation)
            let effective = options ?? DeltaOptions()
            return DeltaBaseline(
                compilation,
                effective,
                DiagnosticDeltaCalculator.Collect(compilation, effective, cancellationToken)
            )
        }
    }
}

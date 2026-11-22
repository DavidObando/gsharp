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
    internal init(
        compilation Compilation,
        options DeltaOptions,
        diagnostics ImmutableArray[Diagnostic],
        analyzerRun AnalyzerRun? = nil
    ) {
        Compilation = compilation
        EffectiveOptions = options
        Diagnostics = diagnostics
        AnalyzerRun = analyzerRun
    }

    /// Gets the compilation before the edit.
    prop Compilation Compilation {
        get;
    }

    /// Gets a copy of the options that the baseline was computed with. Changing it has no effect.
    prop Options DeltaOptions -> EffectiveOptions.Snapshot()

    // The options of the checks, fixed when the baseline was created.
    internal prop EffectiveOptions DeltaOptions {
        get;
    }

    /// Gets the diagnostics before the edit, after the host's filter, in compilation order and then analyzer order.
    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }

    // Issue #6165: the analyzers' diagnostics before the host's filter, each with the body whose
    // dispatch reported it, or `null` when no analyzer ran or the baseline was given its diagnostics.
    internal prop AnalyzerRun AnalyzerRun? {
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
            // A snapshot: a later change to the caller's options must not change what the
            // baseline compares with.
            let effective = (options ?? DeltaOptions()).Snapshot()
            if effective.SyntaxOnly {
                // A syntax-only check reads the parse diagnostics of the trees, not these.
                return DeltaBaseline(compilation, effective, ImmutableArray[Diagnostic].Empty)
            }
            let diagnostics = DiagnosticDeltaCalculator.Collect(compilation, effective, cancellationToken, out var run)
            return DeltaBaseline(compilation, effective, diagnostics, run)
        }
    }
}

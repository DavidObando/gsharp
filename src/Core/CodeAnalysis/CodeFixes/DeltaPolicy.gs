// <copyright file="DeltaPolicy.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import System
import System.Linq

/// A named rule that decides from a (cref:DiagnosticDelta) whether a host offers an edit
/// (ADR-0227 D4). Errors and warnings count, compiler and analyzer diagnostics alike.
class DeltaPolicy {
    private let accepts(DiagnosticDelta) -> bool

    private init(name string, accepts(DiagnosticDelta) -> bool) {
        Name = name
        this.accepts = accepts
    }

    /// Gets the name of the policy.
    prop Name string {
        get;
    }

    /// Returns a value that tells whether the policy accepts the edit.
    /// @param delta The delta of the edit.
    /// @returns `true` when the host can offer the edit.
    /// @remarks A delta that stopped after the parse (cref:DiagnosticDelta.ParseOnly) is a partial
    /// result: no bind ran, so no policy accepts it.
    func Accepts(delta DiagnosticDelta) bool {
        ArgumentNullException.ThrowIfNull(delta)
        return !delta.ParseOnly && accepts(delta)
    }

    /// Returns the name.
    /// @returns The name.
    override func ToString() string -> Name

    shared {
        /// The default (the IntelliCode rule): the edit adds no diagnostic.
        let NoNewDiagnostics DeltaPolicy = DeltaPolicy("NoNewDiagnostics", (d DiagnosticDelta) -> d.Added.IsEmpty)

        /// The edit removes every target and adds no error.
        let RemovesTargetNoNewErrors DeltaPolicy = DeltaPolicy(
            "RemovesTargetNoNewErrors",
            (d DiagnosticDelta) -> d.TargetRemoved && !d.Added.Any((x Diagnostic) -> x.IsError)
        )

        /// The edit removes a diagnostic and the error count goes down. Not a default.
        let NetImprovement DeltaPolicy = DeltaPolicy(
            "NetImprovement",
            (d DiagnosticDelta) -> !d.Removed.IsEmpty && d.Added.Count((x Diagnostic) -> x.IsError) < d.Removed.Count(
                (x Diagnostic) -> x.IsError
            )
        )

        /// For a fix whose targets are all parse errors: the edit removes every target and adds no
        /// syntax diagnostic. Bind diagnostics that the fix makes reachable do not count. For any
        /// other fix it is (cref:NoNewDiagnostics).
        let PhaseAware DeltaPolicy = DeltaPolicy(
            "PhaseAware",
            (d DiagnosticDelta) -> if d.TargetsAreSyntax {
                d.TargetRemoved && d.AddedSyntax.IsEmpty
            } else {
                d.Added.IsEmpty
            }
        )
    }
}

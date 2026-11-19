// <copyright file="DiagnosticDelta.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import System
import System.Collections.Immutable

/// The diagnostics that an edit removes, adds and keeps, over the whole compilation (ADR-0227 D4).
/// The delta is a fact. A (cref:DeltaPolicy) decides whether a host offers the edit.
class DiagnosticDelta {
    internal init(
        removed ImmutableArray[Diagnostic],
        added ImmutableArray[Diagnostic],
        persisting ImmutableArray[Diagnostic],
        addedSyntax ImmutableArray[Diagnostic],
        targetRemoved bool,
        targetsAreSyntax bool,
        parseOnly bool,
        elapsed TimeSpan
    ) {
        Removed = removed
        Added = added
        Persisting = persisting
        AddedSyntax = addedSyntax
        TargetRemoved = targetRemoved
        TargetsAreSyntax = targetsAreSyntax
        ParseOnly = parseOnly
        Elapsed = elapsed
    }

    /// Gets the diagnostics before the edit that the edit removes.
    prop Removed ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the diagnostics after the edit that were not there before.
    prop Added ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the diagnostics after the edit that were there before, with spans in the new text.
    prop Persisting ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the syntax diagnostics in (cref:Added): the diagnostics of the parse of the new text.
    prop AddedSyntax ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets a value that tells whether the edit removes every target diagnostic.
    prop TargetRemoved bool {
        get;
    }

    /// Gets a value that tells whether every target diagnostic is a syntax diagnostic. It is
    /// `false` when there is no target.
    prop TargetsAreSyntax bool {
        get;
    }

    /// Gets a value that tells whether the check stopped after the parse, because the edit added a
    /// syntax diagnostic. Then (cref:Removed), (cref:Added) and (cref:Persisting) hold only syntax diagnostics.
    prop ParseOnly bool {
        get;
    }

    /// Gets the time that the check took.
    prop Elapsed TimeSpan {
        get;
    }
}

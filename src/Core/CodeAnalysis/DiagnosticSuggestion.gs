// <copyright file="DiagnosticSuggestion.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable

/// A fix that the compiler attaches to a diagnostic when it reports it, like a rustc suggestion
/// (ADR-0227 D2 option b). The compiler adds one only when the data is already at hand at the
/// report site. (cref:CodeFixService) turns each suggestion into a (cref:CodeFix).
class DiagnosticSuggestion {
    /// Initializes a new instance of the (cref:DiagnosticSuggestion) class.
    /// @param message The title of the fix.
    /// @param equivalenceKey The key of the kind of fix.
    /// @param applicability How safely a host can apply the fix.
    /// @param changes The changes, in positions of the diagnostic's text and in position order.
    init(message string, equivalenceKey string, applicability Applicability, changes ImmutableArray[TextChange]) {
        ArgumentException.ThrowIfNullOrEmpty(message)
        ArgumentException.ThrowIfNullOrEmpty(equivalenceKey)
        Message = message
        EquivalenceKey = equivalenceKey
        Applicability = applicability
        Changes = if changes.IsDefault {
            ImmutableArray[TextChange].Empty
        } else {
            changes
        }
    }

    /// Gets the title of the fix.
    prop Message string {
        get;
    }

    /// Gets the key of the kind of fix.
    prop EquivalenceKey string {
        get;
    }

    /// Gets how safely a host can apply the fix.
    prop Applicability Applicability {
        get;
    }

    /// Gets the changes, in positions of the diagnostic's text and in position order.
    prop Changes ImmutableArray[TextChange] {
        get;
    }

    /// Returns the message.
    /// @returns The message.
    override func ToString() string -> Message
}

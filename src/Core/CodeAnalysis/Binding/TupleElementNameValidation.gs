// <copyright file="TupleElementNameValidation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable

/// ADR-0172: shared declaration-site validation for tuple element names,
/// used by both tuple type clauses and labeled tuple literals. Reports
/// GS0540 for a name used more than once and GS0542 for reserved names —
/// `ItemN` at any position other than N (the correct-position spelling
/// is allowed, matching C#), and `Rest` (used by the CLR encoding for
/// arity ≥ 8 nesting).
internal shared class TupleElementNameValidation {
    /// Validates the declared names, reporting on the given bag.
    /// @param diagnostics The diagnostic bag to report on.
    /// @param names The declared names, parallel to the element list, `null` where unnamed.
    /// @param locationOf Maps an element index to its name token's location.
    func Validate(diagnostics DiagnosticBag, names ImmutableArray[string?], locationOf(int32) -> TextLocation) {
        var seen HashSet[string]? = nil
        for var i = 0; i < names.Length; i++ {
            let name string? = names[i]
            if name == nil {
                continue
            }
            seen ??= HashSet[string](StringComparer.Ordinal)
            if !seen!!.Add(name) {
                diagnostics.ReportDuplicateTupleElementName(locationOf(i), name)
                continue
            }
            if name == "Rest" {
                diagnostics.ReportReservedTupleElementName(
                    locationOf(i),
                    name,
                    " (used by the CLR ValueTuple encoding)"
                )
                continue
            }
            if name.StartsWith("Item", StringComparison.Ordinal) && int32.TryParse(
                name.Substring(4),
                out var oneBased
            ) &&
                oneBased >= 1 &&
                oneBased != i +
                1 {
                diagnostics.ReportReservedTupleElementName(
                    locationOf(i),
                    name,
                    " at this position; '$name' is only valid as element $oneBased's name"
                )
            }
        }
    }
}

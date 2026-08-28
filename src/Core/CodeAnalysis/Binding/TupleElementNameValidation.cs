// <copyright file="TupleElementNameValidation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0172: shared declaration-site validation for tuple element names,
/// used by both tuple type clauses and labeled tuple literals. Reports
/// GS0540 for a name used more than once and GS0542 for reserved names —
/// <c>ItemN</c> at any position other than N (the correct-position spelling
/// is allowed, matching C#), and <c>Rest</c> (used by the CLR encoding for
/// arity ≥ 8 nesting).
/// </summary>
internal static class TupleElementNameValidation
{
    /// <summary>Validates the declared names, reporting on the given bag.</summary>
    /// <param name="diagnostics">The diagnostic bag to report on.</param>
    /// <param name="names">The declared names, parallel to the element list, <see langword="null"/> where unnamed.</param>
    /// <param name="locationOf">Maps an element index to its name token's location.</param>
    public static void Validate(
        DiagnosticBag diagnostics,
        ImmutableArray<string?> names,
        Func<int, TextLocation> locationOf)
    {
        HashSet<string>? seen = null;
        for (var i = 0; i < names.Length; i++)
        {
            var name = names[i];
            if (name == null)
            {
                continue;
            }

            seen ??= new HashSet<string>(StringComparer.Ordinal);
            if (!seen.Add(name))
            {
                diagnostics.ReportDuplicateTupleElementName(locationOf(i), name);
                continue;
            }

            if (name == "Rest")
            {
                diagnostics.ReportReservedTupleElementName(locationOf(i), name, " (used by the CLR ValueTuple encoding)");
                continue;
            }

            if (name.StartsWith("Item", StringComparison.Ordinal)
                && int.TryParse(name.Substring(4), out var oneBased)
                && oneBased >= 1
                && oneBased != i + 1)
            {
                diagnostics.ReportReservedTupleElementName(
                    locationOf(i),
                    name,
                    $" at this position; '{name}' is only valid as element {oneBased}'s name");
            }
        }
    }
}

// <copyright file="ReaderAgreementAllowlist.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Immutable;
using System.Linq;

namespace GSharp.Core.Tests.ReaderAgreement;

/// <summary>
/// ADR-0193 §4: the known reader disagreements. Every entry names the readers
/// whose answers it excuses, the position fact it is limited to (a harness
/// tag, or none), the issue that tracks closing it, and why. A disagreement is
/// excused only when removing the answers of every applicable entry's readers
/// leaves the remaining readers agreeing, so a second drift on the same
/// position still fails.
/// </summary>
internal static class ReaderAgreementAllowlist
{
    /// <summary>The entries. Each one links an issue.</summary>
    internal static readonly ImmutableArray<Entry> Entries = ImmutableArray.Create(
        new Entry(
            Readers: ImmutableArray.Create("symbolic-call"),
            Tag: null,
            Issue: "https://github.com/DavidObando/gsharp/issues/4363",
            Reason: "MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs maps the open return with "
                + "MapOpenClrTypeToSymbolic and applies no declaration-nullability merge (PR #4362 round 3, "
                + "b0c76053d, deferred it). ADR-0193 Phase 4 closes it."),
        new Entry(
            Readers: ImmutableArray.Create("direct", "projection"),
            Tag: "system-tuple",
            Issue: "https://github.com/DavidObando/gsharp/issues/4401",
            Reason: "FromClrType maps the reference type System.Tuple<...> onto a (value) TupleTypeSymbol "
                + "(#1922); the symbolic projection keeps it an ImportedTypeSymbol reference. Only the CLR "
                + "readers' side of the split is excused, so the symbolic readers must still agree."),
        new Entry(
            Readers: ImmutableArray.Create("merge-symbolic", "member-symbolic", "lazy-symbolic"),
            Tag: "concrete-array-or-tuple",
            Issue: "https://github.com/DavidObando/gsharp/issues/4402",
            Reason: "MergeDeclarationNullability does not descend into FromClrType's ImportedTypeSymbol array "
                + "or TupleTypeSymbol, so a concrete array/tuple position read through a symbolic receiver "
                + "loses its inner nullability."),
        new Entry(
            Readers: ImmutableArray.Create("direct"),
            Tag: "optional-null-default",
            Issue: "https://github.com/DavidObando/gsharp/issues/4403",
            Reason: "ClrNullability.GetParameterTypeSymbol lifts a null-default reference parameter to T?; "
                + "the merge-based parameter reader does not."));

    /// <summary>
    /// Whether <paramref name="disagreement"/> is excused: the answers of every
    /// applicable entry's readers removed, the rest agree.
    /// </summary>
    /// <param name="disagreement">The disagreement.</param>
    /// <returns><see langword="true"/> when excused.</returns>
    internal static bool IsExcused(ReaderAgreementHarness.Disagreement disagreement)
    {
        var excusedReaders = Entries
            .Where(e => e.Tag == null || disagreement.Tags.Contains(e.Tag))
            .SelectMany(e => e.Readers)
            .ToImmutableHashSet(StringComparer.Ordinal);
        if (!disagreement.Results.Any(r => excusedReaders.Contains(r.Reader)))
        {
            return false;
        }

        return disagreement.Results
            .Where(r => !excusedReaders.Contains(r.Reader))
            .Select(r => r.Shape)
            .Distinct(StringComparer.Ordinal)
            .Count() <= 1;
    }

    /// <summary>One allowlisted cause.</summary>
    /// <param name="Readers">The readers whose answers are excused.</param>
    /// <param name="Tag">The harness position tag the entry is limited to, or <see langword="null"/> for every position.</param>
    /// <param name="Issue">The tracking issue (a link — required).</param>
    /// <param name="Reason">Why the readers disagree.</param>
    internal sealed record Entry(ImmutableArray<string> Readers, string? Tag, string Issue, string Reason);
}

// <copyright file="ReaderAgreementAllowlist.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.ReaderAgreement

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// ADR-0193 §4: the known reader disagreements. Every entry names the readers
/// whose answers it excuses, the position fact it is limited to (a harness
/// tag, or none), the issue that tracks closing it, and why. A disagreement is
/// excused only when removing the answers of some applicable entries' readers
/// leaves at least one reader, and every reader left agrees, so a second drift
/// among the readers no entry names still fails.
internal shared class ReaderAgreementAllowlist {
    /// One allowlisted cause.
    /// @param Readers The readers whose answers are excused.
    /// @param Tag The harness position tag the entry is limited to, or `null` for every position.
    /// @param Issue The tracking issue (a link — required).
    /// @param Reason Why the readers disagree.
    internal data class Entry(Readers ImmutableArray[string], Tag string?, Issue string, Reason string) : IEquatable[
        ReaderAgreementAllowlist.Entry
    ] { }

    /// How many readers must still vote, and agree, after the excused ones are
    /// removed. With none left an excusal proves nothing. One is the floor
    /// rather than two, because at a `string?` or `T` closing only the
    /// symbolic readers run, and the #4363 gap leaves exactly one of them
    /// standing against `symbolic-call`.
    private const MinimumRemainingVoters int32 = 1

    /// The entries. Each one links an issue.
    internal let Entries ImmutableArray[ReaderAgreementAllowlist.Entry] = ImmutableArray.Create(
        ReaderAgreementAllowlist.Entry(
            Readers: ImmutableArray.Create("symbolic-call"),
            Tag: nil,
            Issue: "https://github.com/DavidObando/gsharp/issues/4363",
            Reason: "MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs maps the open return with " +
                "MapOpenClrTypeToSymbolic and applies no declaration-nullability merge (PR #4362 round 3, " +
                "b0c76053d, deferred it). ADR-0193 Phase 4 closes it."
        ),
        ReaderAgreementAllowlist.Entry(
            Readers: ImmutableArray.Create("direct", "projection"),
            Tag: "system-tuple",
            Issue: "https://github.com/DavidObando/gsharp/issues/4401",
            Reason: "FromClrType maps the reference type System.Tuple<...> onto a (value) TupleTypeSymbol " +
                "(#1922); the symbolic projection keeps it an ImportedTypeSymbol reference. Only the CLR " +
                "readers' side of the split is excused, so the symbolic readers must still agree."
        ),
        ReaderAgreementAllowlist.Entry(
            Readers: ImmutableArray.Create("direct"),
            Tag: "optional-null-default",
            Issue: "https://github.com/DavidObando/gsharp/issues/4403",
            Reason: "ClrNullability.GetParameterTypeSymbol lifts a null-default reference parameter to T?; " +
                "the merge-based parameter reader does not."
        )
    )

    /// Whether [`disagreement`](paramref) is excused: with some applicable
    /// entries' readers removed, at least one reader remains and all that
    /// remain agree.
    /// @param disagreement The disagreement.
    /// @returns `true` when excused.
    internal func IsExcused(disagreement ReaderAgreementHarness.Disagreement) bool {
        let applicable = Entries.Where(
            (e ReaderAgreementAllowlist.Entry) -> (e.Tag == nil || disagreement.Tags.Contains(e.Tag)) &&
                disagreement
                .Results
                .Any((r ReaderAgreementHarness.ReaderResult) -> e.Readers.Contains(r.Reader))
        )
            .ToImmutableArray()
        // Try every combination of applicable entries. One succeeds only when
        // at least one reader remains and every remaining reader agrees:
        // removing every voter, as a union of overlapping entries could,
        // would excuse any drift at all at that position.
        for var mask = 1; mask < 1 << applicable.Length; mask++ {
            let excusedReaders = applicable
                .Where((_ ReaderAgreementAllowlist.Entry, index int32) -> (mask & (1 << index)) != 0)
                .SelectMany(
                func (e ReaderAgreementAllowlist.Entry) IEnumerable[string] {
                    return e.Readers
                }
            )
                .ToImmutableHashSet(StringComparer.Ordinal)
            let remaining = disagreement
                .Results
                .Where((r ReaderAgreementHarness.ReaderResult) -> !excusedReaders.Contains(r.Reader))
                .ToList()
            if remaining.Count >= MinimumRemainingVoters &&
                remaining
                .Select((r ReaderAgreementHarness.ReaderResult) -> r.Shape)
                .Distinct(StringComparer.Ordinal)
                .Count() == 1 {
                return true
            }
        }
        return false
    }
}

// <copyright file="NullForgivenessTelemetry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Runtime.CompilerServices
import System.Security

/// Per-rule counters for every rule inside `ReceiverNeedsNullForgiveness`
/// (and, transitively, every call site that reaches it) that decided a `!!`
/// non-null assertion was required. Findings from the cs2gs nullability
/// investigation (issue #4262 follow-up) showed the `!!` count reported by
/// `build/cs2gs-counters.sh` is a single aggregate over a decision with
/// ~15 distinct rules — useful for tracking totals, useless for knowing which
/// rule to fix next. This class answers that question directly from the
/// translator itself, rather than from pattern-matching translated text after
/// the fact.
///
/// PR #4277 review note: `ReceiverNeedsNullForgiveness`'s own rules are
/// fully instrumented, but several SIBLING predicates that independently
/// cause a `!!` to be emitted at various call sites — combined with it via
/// `||`, e.g. `ReceiverIsNullableReferenceFieldOrProperty`,
/// `NullableReferenceValueMayBeNull`, the iterator-foreach and
/// imported-tuple-element checks in `TranslateReceiverWithNullForgiveness`
/// — are NOT recorded here. This is therefore a partial, not exhaustive, view
/// of every `!!` emission site; treat (cref:Snapshot) as a lower bound
/// and a rule-attribution tool for the rules it does cover, not a total count
/// (use `build/cs2gs-counters.sh` for the true total).
///
/// Deliberately NOT wired into the translated `.gs` output (a reason string
/// in generated code would be either wrong noise for end users or a
/// maintenance burden to keep faithful) and deliberately NOT gated behind an
/// environment variable in the hot path — (cref:Record) is a single
/// dictionary increment, cheap enough to always run. Consumers (tests, or a
/// future CLI report) opt in by reading (cref:Snapshot); nothing reads
/// it today unless asked to, so normal migration runs are unaffected.
internal shared class NullForgivenessTelemetry {
    private const DumpPathVariable string = "CS2GS_NULL_FORGIVENESS_TELEMETRY"
    private let Counts ConcurrentDictionary[string, int32] = ConcurrentDictionary[string, int32]()

    // The dump path as it was when the exit hook was armed. Read once, so a
    // host that changes or clears the variable before shutdown cannot make
    // the hook write somewhere else, or fail on a null path.
    private let DumpPath string? = Environment.GetEnvironmentVariable(DumpPathVariable)

    // Initializes static members of the (cref:NullForgivenessTelemetry) class.
    // When `CS2GS_NULL_FORGIVENESS_TELEMETRY` names a file, the snapshot
    // is written there (one `count<TAB>reason` line per rule) when
    // the process exits. ADR-0186 step 6 uses it for a whole-corpus per-rule
    // count: set it for `build/run-cs2gs-selfmig-migrate.sh`. Unset, the
    // class behaves exactly as before.
    init {
        if !string.IsNullOrWhiteSpace(DumpPath) {
            AppDomain.CurrentDomain.ProcessExit += WriteSnapshotOnExit
        }
    }

    /// Records one occurrence of [`reason`](paramref) and returns
    /// `true`, so call sites can wrap an existing
    /// `return true;` with `return Record("reason");` without
    /// restructuring the surrounding control flow.
    /// @param reason A short, stable identifier for the rule that fired — conventionally the
    /// issue number the rule was introduced under, e.g. `"2506-promoted-nullable-receiver"`.
    /// Stability matters more than prose: this is a dictionary key other tooling
    /// (tests, reports) may match against, not user-facing text.
    /// @returns Always `true`.
    func Record(reason string) bool {
        Counts.AddOrUpdate(reason, 1, (_ string, count int32) -> count + 1)
        return true
    }

    /// Returns a snapshot of every reason recorded so far, most-frequent
    /// first. Safe to call while translation is still running (e.g., from a
    /// test that translates a fixture and then inspects the result); the
    /// snapshot reflects whatever has been recorded up to the call.
    /// @returns Reason/count pairs, most-frequent first.
    func Snapshot() IReadOnlyList[(Reason string, Count int32)] -> Counts
        .Select((pair KeyValuePair[string, int32]) -> (pair.Key, pair.Value))
        .OrderByDescending((pair(Key string, Value int32)) -> pair.Item2)
        .ThenBy((pair(Key string, Value int32)) -> pair.Item1, StringComparer.Ordinal)
        .ToList()

    /// Clears every counter. Tests that want an isolated count for one
    /// fixture must call this first — counts otherwise accumulate for the
    /// lifetime of the process (translator instances are cheap and per-file,
    /// so nothing else resets this).
    func Reset() -> Counts.Clear()

    /// Runs the static constructor, so that the exit dump is armed even for a
    /// run in which (cref:Record) is never called; such a run then
    /// writes an empty file rather than none. Called when a translator is
    /// constructed.
    internal func EnsureInitialized() {
        // Explicit rather than relying on the call itself: the type has a
        // static constructor (so it is not beforefieldinit and any static
        // call would run it), but this states the intent and survives a
        // later refactor that removes that constructor.
        RuntimeHelpers.RunClassConstructor(typeof(NullForgivenessTelemetry).TypeHandle)
    }

    // Best effort: a measurement dump must never fail a run that otherwise
    // succeeded, so an unwritable path is reported on stderr and dropped.
    // Snapshot() is ordered (count, then reason), so dumps compare line for
    // line across runs.
    private func WriteSnapshotOnExit(sender object, e EventArgs) {
        let lines = List[string]()
        for (reason, count) in Snapshot() {
            lines.Add(count.ToString(CultureInfo.InvariantCulture) + "\t" + reason)
        }
        try {
            let directory string? = Path.GetDirectoryName(Path.GetFullPath(DumpPath!!))
            if !string.IsNullOrEmpty(directory) {
                Directory.CreateDirectory(directory)
            }
            // Written beside the destination and moved over it, so a reader
            // never sees a half-written file and concurrent runs targeting
            // one path leave one run's complete snapshot, not an interleaving.
            let staging = DumpPath + "." + Environment.ProcessId.ToString(CultureInfo.InvariantCulture) + ".tmp"
            File.WriteAllLines(staging, lines)
            File.Move(staging, DumpPath!!, overwrite: true)
        } catch (exception Exception) when exception is IOException ||
            exception is UnauthorizedAccessException ||
            exception is ArgumentException ||
            exception is NotSupportedException ||
            exception is SecurityException {
            Console.Error.WriteLine(
                "cs2gs: could not write the null-forgiveness telemetry snapshot to '" +
                    DumpPath +
                    "' (from " +
                    DumpPathVariable +
                    "): " +
                    exception.Message
            )
        }
    }
}

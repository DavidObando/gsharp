// <copyright file="NullForgivenessTelemetry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Cs2Gs.Translator;

/// <summary>
/// Per-rule counters for every site where the translator decided a `!!`
/// non-null assertion (or the value-position/index-argument/foreach
/// equivalents of the same decision) was required. Findings from the cs2gs
/// nullability investigation (issue #4262 follow-up) showed the `!!` count
/// reported by <c>build/cs2gs-counters.sh</c> is a single aggregate over a
/// decision with ~15 distinct rules — useful for tracking totals, useless for
/// knowing which rule to fix next. This class answers that question directly
/// from the translator itself, rather than from pattern-matching translated
/// text after the fact.
/// <para>
/// Deliberately NOT wired into the translated `.gs` output (a reason string
/// in generated code would be either wrong noise for end users or a
/// maintenance burden to keep faithful) and deliberately NOT gated behind an
/// environment variable in the hot path — <see cref="Record"/> is a single
/// dictionary increment, cheap enough to always run. Consumers (tests, or a
/// future CLI report) opt in by reading <see cref="Snapshot"/>; nothing reads
/// it today unless asked to, so normal migration runs are unaffected.
/// </para>
/// </summary>
internal static class NullForgivenessTelemetry
{
    private static readonly ConcurrentDictionary<string, int> Counts = new ConcurrentDictionary<string, int>();

    /// <summary>
    /// Records one occurrence of <paramref name="reason"/> and returns
    /// <see langword="true"/>, so call sites can wrap an existing
    /// <c>return true;</c> with <c>return Record("reason");</c> without
    /// restructuring the surrounding control flow.
    /// </summary>
    /// <param name="reason">
    /// A short, stable identifier for the rule that fired — conventionally the
    /// issue number the rule was introduced under, e.g. <c>"2506-promoted-nullable-receiver"</c>.
    /// Stability matters more than prose: this is a dictionary key other tooling
    /// (tests, reports) may match against, not user-facing text.
    /// </param>
    /// <returns>Always <see langword="true"/>.</returns>
    public static bool Record(string reason)
    {
        Counts.AddOrUpdate(reason, 1, static (_, count) => count + 1);
        return true;
    }

    /// <summary>
    /// Returns a snapshot of every reason recorded so far, most-frequent
    /// first. Safe to call while translation is still running (e.g., from a
    /// test that translates a fixture and then inspects the result); the
    /// snapshot reflects whatever has been recorded up to the call.
    /// </summary>
    /// <returns>Reason/count pairs, most-frequent first.</returns>
    public static IReadOnlyList<(string Reason, int Count)> Snapshot() =>
        Counts
            .Select(pair => (pair.Key, pair.Value))
            .OrderByDescending(pair => pair.Value)
            .ThenBy(pair => pair.Key, System.StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// Clears every counter. Tests that want an isolated count for one
    /// fixture must call this first — counts otherwise accumulate for the
    /// lifetime of the process (translator instances are cheap and per-file,
    /// so nothing else resets this).
    /// </summary>
    public static void Reset() => Counts.Clear();
}

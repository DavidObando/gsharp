// <copyright file="NullForgivenessTelemetry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Cs2Gs.Translator;

/// <summary>
/// Per-rule counters for every rule inside <c>ReceiverNeedsNullForgiveness</c>
/// (and, transitively, every call site that reaches it) that decided a `!!`
/// non-null assertion was required. Findings from the cs2gs nullability
/// investigation (issue #4262 follow-up) showed the `!!` count reported by
/// <c>build/cs2gs-counters.sh</c> is a single aggregate over a decision with
/// ~15 distinct rules — useful for tracking totals, useless for knowing which
/// rule to fix next. This class answers that question directly from the
/// translator itself, rather than from pattern-matching translated text after
/// the fact.
/// <para>
/// PR #4277 review note: <c>ReceiverNeedsNullForgiveness</c>'s own rules are
/// fully instrumented, but several SIBLING predicates that independently
/// cause a `!!` to be emitted at various call sites — combined with it via
/// `||`, e.g. <c>ReceiverIsNullableReferenceFieldOrProperty</c>,
/// <c>NullableReferenceValueMayBeNull</c>, the iterator-foreach and
/// imported-tuple-element checks in <c>TranslateReceiverWithNullForgiveness</c>
/// — are NOT recorded here. This is therefore a partial, not exhaustive, view
/// of every `!!` emission site; treat <see cref="Snapshot"/> as a lower bound
/// and a rule-attribution tool for the rules it does cover, not a total count
/// (use <c>build/cs2gs-counters.sh</c> for the true total).
/// </para>
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
    private const string DumpPathVariable = "CS2GS_NULL_FORGIVENESS_TELEMETRY";

    private static readonly ConcurrentDictionary<string, int> Counts = new ConcurrentDictionary<string, int>();

    // The dump path as it was when the exit hook was armed. Read once, so a
    // host that changes or clears the variable before shutdown cannot make
    // the hook write somewhere else, or fail on a null path.
    private static readonly string DumpPath = System.Environment.GetEnvironmentVariable(DumpPathVariable);

    /// <summary>
    /// Initializes static members of the <see cref="NullForgivenessTelemetry"/> class.
    /// When <c>CS2GS_NULL_FORGIVENESS_TELEMETRY</c> names a file, the snapshot
    /// is written there (one <c>count&lt;TAB&gt;reason</c> line per rule) when
    /// the process exits. ADR-0186 step 6 uses it for a whole-corpus per-rule
    /// count: set it for <c>build/run-cs2gs-selfmig-migrate.sh</c>. Unset, the
    /// class behaves exactly as before.
    /// </summary>
    static NullForgivenessTelemetry()
    {
        if (!string.IsNullOrWhiteSpace(DumpPath))
        {
            System.AppDomain.CurrentDomain.ProcessExit += WriteSnapshotOnExit;
        }
    }

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

    /// <summary>
    /// Runs the static constructor, so that the exit dump is armed even for a
    /// run in which <see cref="Record"/> is never called; such a run then
    /// writes an empty file rather than none. Called when a translator is
    /// constructed.
    /// </summary>
    internal static void EnsureInitialized()
    {
    }

    // Best effort: a measurement dump must never fail a run that otherwise
    // succeeded, so an unwritable path is reported on stderr and dropped.
    // Snapshot() is ordered (count, then reason), so dumps compare line for
    // line across runs.
    private static void WriteSnapshotOnExit(object sender, System.EventArgs e)
    {
        var lines = new List<string>();
        foreach ((string reason, int count) in Snapshot())
        {
            lines.Add(count.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\t" + reason);
        }

        try
        {
            string directory = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(DumpPath));
            if (!string.IsNullOrEmpty(directory))
            {
                System.IO.Directory.CreateDirectory(directory);
            }

            System.IO.File.WriteAllLines(DumpPath, lines);
        }
        catch (System.Exception exception) when (exception is System.IO.IOException
            or System.UnauthorizedAccessException
            or System.ArgumentException
            or System.NotSupportedException)
        {
            System.Console.Error.WriteLine(
                "cs2gs: could not write " + DumpPathVariable + " to '" + DumpPath + "': " + exception.Message);
        }
    }
}

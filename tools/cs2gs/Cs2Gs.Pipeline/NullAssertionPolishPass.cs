// <copyright file="NullAssertionPolishPass.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #3501 (!! reduction): strips the <c>!!</c> assertions gsc itself
/// reported as redundant (GS0536 — the operand is already non-nullable,
/// statically or through smart-cast narrowing). The compiler is the single
/// source of truth for narrowing, so this pass performs no flow analysis of
/// its own: it deletes exactly the warned token spans and lets the follow-up
/// compile confirm the result. This also matches C# semantics more closely —
/// the C# <c>!</c> the assertion came from performs no runtime check at all.
/// </summary>
public static class NullAssertionPolishPass
{
    /// <summary>The diagnostic id this pass consumes.</summary>
    public const string DiagnosticId = "GS0536";

    /// <summary>
    /// The MSBuild property, and its value, that demotes <see cref="DiagnosticId"/>
    /// back to a warning for the duration of a survey round (issue #3782). The
    /// migrated tree inherits the repository's <c>TreatWarningsAsErrors</c>, so
    /// without this a build stops at the first project holding a redundant
    /// <c>!!</c> and reports nothing about the projects behind it.
    /// </summary>
    public const string SurveyWarningsNotAsErrors = DiagnosticId;

    /// <summary>
    /// Issue #3723: the round cap <c>RunToFixedPoint</c> stops at.
    /// <para>
    /// The loop cannot actually run forever — <see cref="Strip"/> only ever
    /// DELETES <c>!!</c> tokens and a round that strips none breaks out, so the
    /// number of rounds is bounded by the number of assertions in the tree. The
    /// cap is a cost guard, not a termination guard, and hitting it is reported
    /// rather than silent.
    /// </para>
    /// <para>
    /// Issue #3782: it used to be the binding constraint on any deep graph. One
    /// round can only strip what the compile it followed reported, and a
    /// warnings-as-errors compile reports nothing past the first project it
    /// fails on — so <c>tools/cs2gs/Cs2Gs.Tests</c>, which pulls twelve
    /// projects into its build, needed roughly one round per project (~40) and
    /// exhausted the cap with 14752 <c>GS0536</c> still standing. The loop now
    /// SURVEYS instead: every round after the first demotes <c>GS0536</c> to a
    /// warning (<see cref="SurveyWarningsNotAsErrors"/>), so a single build
    /// walks the whole graph and reports every redundant assertion in it at
    /// once. Convergence is then a function of assertion NESTING
    /// (<c>a!!.b!!</c>), not of graph depth, and the cap stops being reachable.
    /// </para>
    /// </summary>
    public const int DefaultMaxRounds = 12;

    /// <summary>
    /// Issue #3723: strips the GS0536 spans of <paramref name="initial"/>,
    /// recompiles, and repeats until a compile reports no redundant <c>!!</c>
    /// (or a round finds nothing left it can strip). The recompile is what
    /// validates each round: a round is only kept when the polished build is
    /// no worse than the one before it, and otherwise the round's text is
    /// rolled back and the prior result stands — a <c>!!</c> the compiler
    /// still needs therefore survives, because the file it was removed from is
    /// restored wholesale.
    /// <para>
    /// Issue #3782: the first round's recompile is strict, exactly as before,
    /// so an app that converges in one round does exactly one build and nothing
    /// changes for it. Only when that round leaves reports standing — the
    /// signature of a build that stopped part-way up a project graph — do
    /// subsequent rounds switch to survey mode, and a final STRICT build then
    /// produces the result the caller acts on. A survey build's verdict is
    /// never returned: it saw GS0536 as a warning, so its success would mean
    /// nothing.
    /// </para>
    /// </summary>
    /// <param name="initial">The first compile's result.</param>
    /// <param name="recompile">
    /// Reruns the same compile over the rewritten files. The argument asks for
    /// SURVEY mode: <see langword="true"/> demotes <see cref="DiagnosticId"/>
    /// to a warning (see <see cref="SurveyWarningsNotAsErrors"/>) so the build
    /// reports the whole project graph instead of stopping at the first
    /// offender; <see langword="false"/> is the gate's own strict compile.
    /// </param>
    /// <param name="emittedGsFiles">The emitted .gs file paths owned by this app.</param>
    /// <param name="strippableRoot">The optional shared emitted-output root.</param>
    /// <param name="maxRounds">The round cap (see <see cref="DefaultMaxRounds"/>).</param>
    /// <returns>The final compile result and what the loop did to reach it.</returns>
    public static PolishLoopOutcome RunToFixedPoint(
        SdkCompileResult initial,
        Func<bool, SdkCompileResult> recompile,
        IReadOnlyCollection<string> emittedGsFiles,
        string strippableRoot = null,
        int maxRounds = DefaultMaxRounds) =>
        Run(initial, recompile, emittedGsFiles, strippableRoot, maxRounds, surveyAvailable: true);

    /// <summary>
    /// Convenience overload for callers with no survey-mode compile to offer
    /// (the unit tests, and any direct-gsc path): every round compiles strictly.
    /// </summary>
    /// <param name="initial">The first compile's result.</param>
    /// <param name="recompile">Reruns the same strict compile.</param>
    /// <param name="emittedGsFiles">The emitted .gs file paths owned by this app.</param>
    /// <param name="strippableRoot">The optional shared emitted-output root.</param>
    /// <param name="maxRounds">The round cap (see <see cref="DefaultMaxRounds"/>).</param>
    /// <returns>The final compile result and what the loop did to reach it.</returns>
    public static PolishLoopOutcome RunToFixedPoint(
        SdkCompileResult initial,
        Func<SdkCompileResult> recompile,
        IReadOnlyCollection<string> emittedGsFiles,
        string strippableRoot = null,
        int maxRounds = DefaultMaxRounds)
    {
        if (recompile is null)
        {
            throw new ArgumentNullException(nameof(recompile));
        }

        return Run(initial, _ => recompile(), emittedGsFiles, strippableRoot, maxRounds, surveyAvailable: false);
    }

    /// <summary>
    /// Deletes every GS0536-flagged <c>!!</c> span from the given emitted
    /// files. Spans are applied bottom-up per file so earlier deletions never
    /// shift later coordinates, and each span is verified to hold exactly
    /// <c>!!</c> before deletion (a mismatch skips the span rather than
    /// corrupting the file).
    /// </summary>
    /// <param name="diagnostics">The compile run's parsed diagnostics.</param>
    /// <param name="emittedGsFiles">The emitted .gs file paths owned by this app.</param>
    /// <param name="strippableRoot">
    /// Optional directory under which ANY emitted <c>.gs</c> may be polished —
    /// an app's SDK build also compiles its project references, and a
    /// dependency whose own compile stage never ran (translation-unsupported)
    /// still carries redundant assertions that fail this app's
    /// warnings-as-errors build.
    /// </param>
    /// <returns>The number of assertions removed.</returns>
    public static int Strip(
        IReadOnlyList<GscDiagnostic> diagnostics,
        IReadOnlyCollection<string> emittedGsFiles,
        string strippableRoot = null)
    {
        if (diagnostics is null || diagnostics.Count == 0 || emittedGsFiles is null || emittedGsFiles.Count == 0)
        {
            return 0;
        }

        Dictionary<string, string> ownedByFullPath = BuildOwnedIndex(emittedGsFiles);

        var stripped = 0;
        IEnumerable<IGrouping<string, GscDiagnostic>> byFile = diagnostics
            .Where(d => string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal)
                && d.Line == d.EndLine
                && d.EndColumn - d.Column == 2)
            .GroupBy(d => ResolveStrippableFile(d.File, ownedByFullPath, strippableRoot))
            .Where(g => g.Key != null);

        foreach (IGrouping<string, GscDiagnostic> group in byFile)
        {
            string[] lines = File.ReadAllLines(group.Key);
            var changed = false;
            foreach (GscDiagnostic diagnostic in group
                .Distinct(SpanComparer.Instance)
                .OrderByDescending(d => d.Line)
                .ThenByDescending(d => d.Column))
            {
                int lineIndex = diagnostic.Line - 1;
                int start = diagnostic.Column - 1;
                if (lineIndex < 0 || lineIndex >= lines.Length)
                {
                    continue;
                }

                string line = lines[lineIndex];
                if (start < 0 || start + 2 > line.Length
                    || line[start] != '!' || line[start + 1] != '!')
                {
                    continue;
                }

                lines[lineIndex] = line.Remove(start, 2);
                changed = true;
                stripped++;
            }

            if (changed)
            {
                File.WriteAllLines(group.Key, lines);
            }
        }

        return stripped;
    }

    /// <summary>
    /// Lists the files a <see cref="Strip"/> call with the same arguments
    /// would touch, so callers can snapshot them for rollback first.
    /// </summary>
    /// <param name="diagnostics">The compile run's parsed diagnostics.</param>
    /// <param name="emittedGsFiles">The emitted .gs file paths owned by this app.</param>
    /// <param name="strippableRoot">The optional shared emitted-output root.</param>
    /// <returns>The distinct resolved file paths.</returns>
    public static IReadOnlyCollection<string> CandidateFiles(
        IReadOnlyList<GscDiagnostic> diagnostics,
        IReadOnlyCollection<string> emittedGsFiles,
        string strippableRoot = null)
    {
        if (diagnostics is null || diagnostics.Count == 0 || emittedGsFiles is null || emittedGsFiles.Count == 0)
        {
            return Array.Empty<string>();
        }

        Dictionary<string, string> ownedByFullPath = BuildOwnedIndex(emittedGsFiles);

        return diagnostics
            .Where(d => string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal))
            .Select(d => ResolveStrippableFile(d.File, ownedByFullPath, strippableRoot))
            .Where(f => f != null)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static PolishLoopOutcome Run(
        SdkCompileResult initial,
        Func<bool, SdkCompileResult> recompile,
        IReadOnlyCollection<string> emittedGsFiles,
        string strippableRoot,
        int maxRounds,
        bool surveyAvailable)
    {
        if (initial is null)
        {
            throw new ArgumentNullException(nameof(initial));
        }

        if (recompile is null)
        {
            throw new ArgumentNullException(nameof(recompile));
        }

        SdkCompileResult result = initial;
        var rounds = 0;
        var stripped = 0;
        var builds = 0;
        var surveyBuilds = 0;

        // Set once a round has been kept, so round 2 onwards surveys. Cleared
        // for good if a strict confirmation proves surveying changed nothing —
        // an SDK too old to understand WarningsNotAsErrors degrades to the
        // pre-#3782 strict loop rather than paying for a confirmation per round.
        var survey = false;
        bool surveyWorks = surveyAvailable;
        var capExhausted = false;
        var abandoned = false;

        while (true)
        {
            while (result.IsAvailable && Reports(result.Diagnostics))
            {
                if (rounds >= maxRounds)
                {
                    capExhausted = true;
                    break;
                }

                rounds++;
                Dictionary<string, string> backups = CandidateFiles(result.Diagnostics, emittedGsFiles, strippableRoot)
                    .Concat(emittedGsFiles ?? Array.Empty<string>())
                    .Where(File.Exists)
                    .Distinct(StringComparer.Ordinal)
                    .ToDictionary(f => f, File.ReadAllText, StringComparer.Ordinal);

                int roundStripped = Strip(result.Diagnostics, emittedGsFiles, strippableRoot);
                if (roundStripped == 0)
                {
                    // Every reported span was one this pass declines to touch
                    // (a stale coordinate, or a file outside the strippable set):
                    // another round would report the same thing.
                    break;
                }

                stripped += roundStripped;
                bool surveyThisRound = survey && surveyWorks;
                SdkCompileResult polished = recompile(surveyThisRound);
                builds++;
                if (surveyThisRound)
                {
                    surveyBuilds++;
                }

                if (polished.IsAvailable && (polished.Succeeded || !result.Succeeded))
                {
                    result = polished;
                    survey = true;
                    continue;
                }

                // The polished build regressed a previously passing one (or could
                // not run at all): restore the round's text and keep the result
                // that stood before it.
                foreach (KeyValuePair<string, string> backup in backups)
                {
                    File.WriteAllText(backup.Key, backup.Value);
                }

                abandoned = true;
                break;
            }

            if (surveyBuilds == 0 || !result.IsAvailable)
            {
                break;
            }

            // `result` came from a build that saw GS0536 as a warning, so it is
            // not a verdict. Recompile strictly over the same text; that build
            // is what the caller gets, and it is also the proof that the polish
            // converged.
            result = recompile(false);
            builds++;
            surveyBuilds = 0;
            survey = false;
            if (abandoned || capExhausted || !result.IsAvailable || !Reports(result.Diagnostics))
            {
                break;
            }

            // Surveying bought nothing (the property never reached gsc): fall
            // back to the strict round-per-project loop for whatever budget is
            // left, and never pay for another confirmation.
            surveyWorks = false;
        }

        return new PolishLoopOutcome(result, rounds, stripped, capExhausted, builds);
    }

    private static bool Reports(IReadOnlyList<GscDiagnostic> diagnostics) =>
        diagnostics.Any(d => string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal));

    // Indexes the app-owned emitted files by BOTH the raw full path and the
    // symlink-canonical path, so a diagnostic echoing either spelling matches.
    private static Dictionary<string, string> BuildOwnedIndex(IReadOnlyCollection<string> emittedGsFiles)
    {
        var index = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string file in emittedGsFiles)
        {
            if (!File.Exists(file))
            {
                continue;
            }

            string full = Path.GetFullPath(file);
            index.TryAdd(full, file);
            index.TryAdd(CanonicalizePath(full), file);
        }

        return index;
    }

    private static string ResolveStrippableFile(
        string diagnosticFile,
        IReadOnlyDictionary<string, string> ownedByFullPath,
        string strippableRoot)
    {
        if (string.IsNullOrEmpty(diagnosticFile))
        {
            return null;
        }

        string normalized;
        try
        {
            normalized = Path.GetFullPath(diagnosticFile);
        }
        catch (Exception e) when (e is ArgumentException or PathTooLongException or NotSupportedException)
        {
            return null;
        }

        // Issue #3501: gsc echoes SYMLINK-RESOLVED paths on macOS
        // (`/private/tmp/…`) while the pipeline's owned/root paths keep the
        // spelling it was invoked with (`/tmp/…`), so both comparisons below
        // run over canonical real paths.
        string canonical = CanonicalizePath(normalized);
        if (ownedByFullPath.TryGetValue(normalized, out string owned)
            || ownedByFullPath.TryGetValue(canonical, out owned))
        {
            return owned;
        }

        if (string.IsNullOrEmpty(strippableRoot)
            || !normalized.EndsWith(".gs", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(normalized))
        {
            return null;
        }

        string root = Path.GetFullPath(strippableRoot)
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string canonicalRoot = CanonicalizePath(root.TrimEnd(Path.DirectorySeparatorChar))
            + Path.DirectorySeparatorChar;
        return normalized.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            || canonical.StartsWith(canonicalRoot, StringComparison.OrdinalIgnoreCase)
                ? normalized
                : null;
    }

    // Resolves directory symlinks in the path's ancestry (macOS `/tmp` →
    // `/private/tmp`) by round-tripping through the filesystem; falls back to
    // the input when nothing exists to resolve against.
    private static string CanonicalizePath(string path)
    {
        try
        {
            string directory = Path.GetDirectoryName(path);
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
            {
                return path;
            }

            var info = new DirectoryInfo(directory);
            string resolvedDirectory = info.ResolveLinkTarget(returnFinalTarget: true)?.FullName
                ?? ResolveAncestrySymlinks(directory);
            return Path.Combine(resolvedDirectory, Path.GetFileName(path));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return path;
        }
    }

    private static string ResolveAncestrySymlinks(string directory)
    {
        // `ResolveLinkTarget` only resolves when the FINAL component is the
        // link; `/tmp/foo/bar` needs `/tmp` itself resolved. Walk up until a
        // component resolves, then reattach the remainder.
        string current = directory;
        var suffix = new List<string>();
        while (!string.IsNullOrEmpty(current))
        {
            if (Directory.Exists(current))
            {
                string resolved = new DirectoryInfo(current)
                    .ResolveLinkTarget(returnFinalTarget: true)?.FullName;
                if (resolved != null)
                {
                    suffix.Reverse();
                    return suffix.Aggregate(resolved, Path.Combine);
                }
            }

            string name = Path.GetFileName(current);
            string parent = Path.GetDirectoryName(current);
            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(parent) || parent == current)
            {
                break;
            }

            suffix.Add(name);
            current = parent;
        }

        return directory;
    }

    /// <summary>
    /// Issue #3723: what a <c>RunToFixedPoint</c> call did — enough for
    /// the caller to say out loud that the loop gave up, which is how the
    /// old three-round cap stayed invisible for several nightly runs.
    /// </summary>
    public sealed class PolishLoopOutcome
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="PolishLoopOutcome"/> class.
        /// </summary>
        /// <param name="result">The final compile result.</param>
        /// <param name="rounds">The number of strip-and-recompile rounds run.</param>
        /// <param name="stripped">The total number of assertions removed.</param>
        /// <param name="capExhausted">Whether the round cap stopped the loop.</param>
        /// <param name="builds">The number of recompiles the loop paid for.</param>
        public PolishLoopOutcome(
            SdkCompileResult result, int rounds, int stripped, bool capExhausted, int builds = 0)
        {
            this.Result = result;
            this.Rounds = rounds;
            this.Stripped = stripped;
            this.CapExhausted = capExhausted;
            this.Builds = builds;
        }

        /// <summary>Gets the final compile result.</summary>
        public SdkCompileResult Result { get; }

        /// <summary>Gets the number of strip-and-recompile rounds run.</summary>
        public int Rounds { get; }

        /// <summary>Gets the total number of assertions removed.</summary>
        public int Stripped { get; }

        /// <summary>Gets a value indicating whether the round cap stopped the loop.</summary>
        public bool CapExhausted { get; }

        /// <summary>
        /// Gets the number of recompiles the loop paid for — the honest cost
        /// unit, since a round and a build stopped being the same thing when
        /// #3782 added the strict confirmation compile.
        /// </summary>
        public int Builds { get; }

        /// <summary>
        /// Gets the number of redundant-<c>!!</c> reports still standing,
        /// counted by distinct source span: MSBuild echoes each diagnostic
        /// again in its end-of-build summary, so the raw count double-counts.
        /// </summary>
        public int RemainingReports => this.Result.Diagnostics
            .Where(d => string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal))
            .Select(d => (d.File, d.Line, d.Column))
            .Distinct()
            .Count();
    }

    private sealed class SpanComparer : IEqualityComparer<GscDiagnostic>
    {
        public static readonly SpanComparer Instance = new SpanComparer();

        public bool Equals(GscDiagnostic x, GscDiagnostic y) =>
            x!.Line == y!.Line && x.Column == y.Column;

        public int GetHashCode(GscDiagnostic obj) => (obj.Line * 397) ^ obj.Column;
    }
}

// <copyright file="NullAssertionPolishPass.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Issue #3501 (!! reduction): strips the `!!` assertions gsc itself
/// reported as redundant (GS0536 — the operand is already non-nullable,
/// statically or through smart-cast narrowing). The compiler is the single
/// source of truth for narrowing, so this pass performs no flow analysis of
/// its own: it deletes exactly the warned token spans and lets the follow-up
/// compile confirm the result. This also matches C# semantics more closely —
/// the C# `!` the assertion came from performs no runtime check at all.
shared class NullAssertionPolishPass {
    /// Issue #3723: what a `RunToFixedPoint` call did — enough for
    /// the caller to say out loud that the loop gave up, which is how the
    /// old three-round cap stayed invisible for several nightly runs.
    class PolishLoopOutcome {
        /// Initializes a new instance of the (cref:PolishLoopOutcome) class.
        /// @param result The final compile result.
        /// @param rounds The number of strip-and-recompile rounds run.
        /// @param stripped The total number of assertions removed.
        /// @param capExhausted Whether the round cap stopped the loop.
        /// @param builds The number of recompiles the loop paid for.
        init(result SdkCompileResult, rounds int32, stripped int32, capExhausted bool, builds int32 = 0) {
            this.Result = result
            this.Rounds = rounds
            this.Stripped = stripped
            this.CapExhausted = capExhausted
            this.Builds = builds
        }

        /// Gets the final compile result.
        prop Result SdkCompileResult {
            get;
        }

        /// Gets the number of strip-and-recompile rounds run.
        prop Rounds int32 {
            get;
        }

        /// Gets the total number of assertions removed.
        prop Stripped int32 {
            get;
        }

        /// Gets a value indicating whether the round cap stopped the loop.
        prop CapExhausted bool {
            get;
        }

        /// Gets the number of recompiles the loop paid for — the honest cost
        /// unit, since a round and a build stopped being the same thing when
        /// #3782 added the strict confirmation compile.
        prop Builds int32 {
            get;
        }

        /// Gets the number of redundant-`!!` reports still standing,
        /// counted by distinct source span: MSBuild echoes each diagnostic
        /// again in its end-of-build summary, so the raw count double-counts.
        prop RemainingReports int32 -> this
            .Result
            .Diagnostics
            .Where(
            (d GscDiagnostic) -> string.Equals(d.Id, NullAssertionPolishPass.DiagnosticId, StringComparison.Ordinal)
        )
            .Select((d GscDiagnostic) -> (d.File, d.Line, d.Column))
            .Distinct()
            .Count()
    }

    private class SpanComparer : IEqualityComparer[GscDiagnostic] {
        func Equals(x GscDiagnostic, y GscDiagnostic) bool -> x.Line == y.Line && x.Column == y.Column

        func GetHashCode(obj GscDiagnostic) int32 -> (obj.Line * 397) ^ obj.Column

        shared {
            let Instance SpanComparer = SpanComparer()
        }
    }

    /// The diagnostic id this pass consumes.
    const DiagnosticId string = "GS0536"

    /// The MSBuild property, and its value, that demotes (cref:DiagnosticId)
    /// back to a warning for the duration of a survey round (issue #3782). The
    /// migrated tree inherits the repository's `TreatWarningsAsErrors`, so
    /// without this a build stops at the first project holding a redundant
    /// `!!` and reports nothing about the projects behind it.
    const SurveyWarningsNotAsErrors string = DiagnosticId

    /// Issue #3723: the round cap `RunToFixedPoint` stops at.
    ///
    /// The loop cannot actually run forever — (cref:Strip) only ever
    /// DELETES `!!` tokens and a round that strips none breaks out, so the
    /// number of rounds is bounded by the number of assertions in the tree. The
    /// cap is a cost guard, not a termination guard, and hitting it is reported
    /// rather than silent.
    ///
    /// Issue #3782: it used to be the binding constraint on any deep graph. One
    /// round can only strip what the compile it followed reported, and a
    /// warnings-as-errors compile reports nothing past the first project it
    /// fails on — so `tools/cs2gs/Cs2Gs.Tests`, which pulls twelve
    /// projects into its build, needed roughly one round per project (~40) and
    /// exhausted the cap with 14752 `GS0536` still standing. The loop now
    /// SURVEYS instead: every round after the first demotes `GS0536` to a
    /// warning ((cref:SurveyWarningsNotAsErrors)), so a single build
    /// walks the whole graph and reports every redundant assertion in it at
    /// once. Convergence is then a function of assertion NESTING
    /// (`a!!.b!!`), not of graph depth, and the cap stops being reachable.
    const DefaultMaxRounds int32 = 12

    /// Issue #3723: strips the GS0536 spans of [`initial`](paramref),
    /// recompiles, and repeats until a compile reports no redundant `!!`
    /// (or a round finds nothing left it can strip). The recompile is what
    /// validates each round: a round is only kept when the polished build is
    /// no worse than the one before it, and otherwise the round's text is
    /// rolled back and the prior result stands — a `!!` the compiler
    /// still needs therefore survives, because the file it was removed from is
    /// restored wholesale.
    ///
    /// Issue #3782: the first round's recompile is strict, exactly as before,
    /// so an app that converges in one round does exactly one build and nothing
    /// changes for it. Only when that round leaves reports standing — the
    /// signature of a build that stopped part-way up a project graph — do
    /// subsequent rounds switch to survey mode, and a final STRICT build then
    /// produces the result the caller acts on. A survey build's verdict is
    /// never returned: it saw GS0536 as a warning, so its success would mean
    /// nothing.
    /// @param initial The first compile's result.
    /// @param recompile Reruns the same compile over the rewritten files. The argument asks for
    /// SURVEY mode: `true` demotes (cref:DiagnosticId)
    /// to a warning (see (cref:SurveyWarningsNotAsErrors)) so the build
    /// reports the whole project graph instead of stopping at the first
    /// offender; `false` is the gate's own strict compile.
    /// @param emittedGsFiles The emitted .gs file paths owned by this app.
    /// @param strippableRoot The optional shared emitted-output root.
    /// @param maxRounds The round cap (see (cref:DefaultMaxRounds)).
    /// @returns The final compile result and what the loop did to reach it.
    func RunToFixedPoint(
        initial SdkCompileResult?,
        recompile((bool) -> SdkCompileResult)?,
        emittedGsFiles IReadOnlyCollection[string],
        strippableRoot string? = nil,
        maxRounds int32 = 12
    ) PolishLoopOutcome -> Run(initial, recompile, emittedGsFiles, strippableRoot, maxRounds, surveyAvailable: true)

    /// Convenience overload for callers with no survey-mode compile to offer
    /// (the unit tests, and any direct-gsc path): every round compiles strictly.
    /// @param initial The first compile's result.
    /// @param recompile Reruns the same strict compile.
    /// @param emittedGsFiles The emitted .gs file paths owned by this app.
    /// @param strippableRoot The optional shared emitted-output root.
    /// @param maxRounds The round cap (see (cref:DefaultMaxRounds)).
    /// @returns The final compile result and what the loop did to reach it.
    func RunToFixedPoint(
        initial SdkCompileResult,
        recompile(() -> SdkCompileResult)?,
        emittedGsFiles IReadOnlyCollection[string],
        strippableRoot string? = nil,
        maxRounds int32 = 12
    ) PolishLoopOutcome {
        if recompile == nil {
            throw ArgumentNullException("recompile")
        }
        return Run(initial, (_ bool) -> recompile(), emittedGsFiles, strippableRoot, maxRounds, surveyAvailable: false)
    }

    /// Deletes every GS0536-flagged `!!` span from the given emitted
    /// files. Spans are applied bottom-up per file so earlier deletions never
    /// shift later coordinates, and each span is verified to hold exactly
    /// `!!` before deletion (a mismatch skips the span rather than
    /// corrupting the file).
    /// @param diagnostics The compile run's parsed diagnostics.
    /// @param emittedGsFiles The emitted .gs file paths owned by this app.
    /// @param strippableRoot Optional directory under which ANY emitted `.gs` may be polished —
    /// an app's SDK build also compiles its project references, and a
    /// dependency whose own compile stage never ran (translation-unsupported)
    /// still carries redundant assertions that fail this app's
    /// warnings-as-errors build.
    /// @returns The number of assertions removed.
    func Strip(
        diagnostics IReadOnlyList[GscDiagnostic]?,
        emittedGsFiles IReadOnlyCollection[string]?,
        strippableRoot string? = nil
    ) int32 {
        if diagnostics == nil || diagnostics.Count == 0 || emittedGsFiles == nil || emittedGsFiles.Count == 0 {
            return 0
        }
        let ownedByFullPath = BuildOwnedIndex(emittedGsFiles)
        var stripped = 0
        let byFile = diagnostics
            .Where(
            (d GscDiagnostic) -> string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal) &&
                d.Line == d.EndLine &&
                d.EndColumn - d.Column == 2
        )
            .GroupBy(
            (d GscDiagnostic) -> ResolveStrippableFile(d.File, ownedByFullPath, strippableRoot) ?? string.Empty
        )
            .Where((g IGrouping[string, GscDiagnostic]) -> g.Key.Length != 0)
        for group in byFile {
            let lines = File.ReadAllLines(group.Key)
            var changed = false
            for diagnostic in group
                .Distinct(SpanComparer.Instance)
                .OrderByDescending((d GscDiagnostic) -> d.Line)
                .ThenByDescending((d GscDiagnostic) -> d.Column) {
                let lineIndex = diagnostic.Line - 1
                let start = diagnostic.Column - 1
                if lineIndex < 0 || lineIndex >= lines.Length {
                    continue
                }
                let line = lines[lineIndex]
                if start < 0 || start + 2 > line.Length || line[start] != '!' || line[start + 1] != '!' {
                    continue
                }
                lines[lineIndex] = line.Remove(start, 2)
                changed = true
                stripped++
            }
            if changed {
                File.WriteAllLines(group.Key, lines)
            }
        }
        return stripped
    }

    /// Lists the files a (cref:Strip) call with the same arguments
    /// would touch, so callers can snapshot them for rollback first.
    /// @param diagnostics The compile run's parsed diagnostics.
    /// @param emittedGsFiles The emitted .gs file paths owned by this app.
    /// @param strippableRoot The optional shared emitted-output root.
    /// @returns The distinct resolved file paths.
    func CandidateFiles(
        diagnostics IReadOnlyList[GscDiagnostic]?,
        emittedGsFiles IReadOnlyCollection[string]?,
        strippableRoot string? = nil
    ) IReadOnlyCollection[string] {
        if diagnostics == nil || diagnostics.Count == 0 || emittedGsFiles == nil || emittedGsFiles.Count == 0 {
            return Array.Empty[string]()
        }
        let ownedByFullPath = BuildOwnedIndex(emittedGsFiles)
        let files = List[string]()
        for diagnostic in diagnostics {
            if !string.Equals(diagnostic.Id, DiagnosticId, StringComparison.Ordinal) {
                continue
            }
            if ResolveStrippableFile(diagnostic.File, ownedByFullPath, strippableRoot) is string file {
                files.Add(file)
            }
        }
        return files.Distinct(StringComparer.OrdinalIgnoreCase).ToList()
    }

    private func Run(
        initial SdkCompileResult?,
        recompile((bool) -> SdkCompileResult)?,
        emittedGsFiles IReadOnlyCollection[string],
        strippableRoot string?,
        maxRounds int32,
        surveyAvailable bool
    ) PolishLoopOutcome {
        if initial == nil {
            throw ArgumentNullException("initial")
        }
        if recompile == nil {
            throw ArgumentNullException("recompile")
        }
        var result SdkCompileResult? = initial
        var rounds = 0
        var stripped = 0
        var builds = 0
        var surveyBuilds = 0
        // Set once a round has been kept, so round 2 onwards surveys. Cleared
        // for good if a strict confirmation proves surveying changed nothing —
        // an SDK too old to understand WarningsNotAsErrors degrades to the
        // pre-#3782 strict loop rather than paying for a confirmation per round.
        var survey = false
        var surveyWorks = surveyAvailable
        var capExhausted = false
        var abandoned = false
        while true {
            while result!!.IsAvailable && Reports(result!!.Diagnostics) {
                if rounds >= maxRounds {
                    capExhausted = true
                    break
                }
                rounds++
                let backups = CandidateFiles(result!!.Diagnostics, emittedGsFiles, strippableRoot)
                    .Concat(emittedGsFiles ?? Array.Empty[string]())
                    .Where(File.Exists)
                    .Distinct(StringComparer.Ordinal)
                    .ToDictionary(
                    func (f string) string {
                        return f
                    },
                    File.ReadAllText,
                    StringComparer.Ordinal
                )
                let roundStripped = Strip(result!!.Diagnostics, emittedGsFiles, strippableRoot)
                if roundStripped == 0 {
                    // Every reported span was one this pass declines to touch
                    // (a stale coordinate, or a file outside the strippable set):
                    // another round would report the same thing.
                    break
                }
                stripped += roundStripped
                let surveyThisRound = survey && surveyWorks
                let polished = recompile(surveyThisRound)
                builds++
                if surveyThisRound {
                    surveyBuilds++
                }
                if polished.IsAvailable && (polished.Succeeded || !result!!.Succeeded) {
                    result = polished
                    survey = true
                    continue
                }
                // The polished build regressed a previously passing one (or could
                // not run at all): restore the round's text and keep the result
                // that stood before it.
                for backup in backups {
                    File.WriteAllText(backup.Key, backup.Value)
                }
                abandoned = true
                break
            }
            if surveyBuilds == 0 || !result!!.IsAvailable {
                break
            }
            // `result` came from a build that saw GS0536 as a warning, so it is
            // not a verdict. Recompile strictly over the same text; that build
            // is what the caller gets, and it is also the proof that the polish
            // converged.
            result = recompile(false)
            builds++
            surveyBuilds = 0
            survey = false
            if abandoned || capExhausted || !result.IsAvailable || !Reports(result.Diagnostics) {
                break
            }
            // Surveying bought nothing (the property never reached gsc): fall
            // back to the strict round-per-project loop for whatever budget is
            // left, and never pay for another confirmation.
            surveyWorks = false
        }
        return PolishLoopOutcome(result!!, rounds, stripped, capExhausted, builds)
    }

    private func Reports(diagnostics IReadOnlyList[GscDiagnostic]) bool -> diagnostics.Any(
        (d GscDiagnostic) -> string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal)
    )

    // Indexes the app-owned emitted files by BOTH the raw full path and the
    // symlink-canonical path, so a diagnostic echoing either spelling matches.
    private func BuildOwnedIndex(emittedGsFiles IReadOnlyCollection[string]?) Dictionary[string, string] {
        let index = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        for file in emittedGsFiles!! {
            if !File.Exists(file) {
                continue
            }
            let full = Path.GetFullPath(file)
            index.TryAdd(full, file)
            index.TryAdd(CanonicalizePath(full), file)
        }
        return index
    }

    private func ResolveStrippableFile(
        diagnosticFile string,
        ownedByFullPath IReadOnlyDictionary[string, string],
        strippableRoot string?
    ) string? {
        if string.IsNullOrEmpty(diagnosticFile) {
            return nil
        }
        var normalized string
        try {
            normalized = Path.GetFullPath(diagnosticFile)
        } catch (e Exception) when e is ArgumentException || e is PathTooLongException || e is NotSupportedException {
            return nil
        }
        // Issue #3501: gsc echoes SYMLINK-RESOLVED paths on macOS
        // (`/private/tmp/…`) while the pipeline's owned/root paths keep the
        // spelling it was invoked with (`/tmp/…`), so both comparisons below
        // run over canonical real paths.
        let canonical = CanonicalizePath(normalized)
        if ownedByFullPath.TryGetValue(normalized, out var owned) || ownedByFullPath.TryGetValue(canonical, out owned) {
            return owned
        }
        if string.IsNullOrEmpty(strippableRoot) || !normalized.EndsWith(".gs", StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(normalized) {
            return nil
        }
        let root = Path.GetFullPath(strippableRoot!!).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar
        let canonicalRoot = CanonicalizePath(root.TrimEnd(Path.DirectorySeparatorChar)) + Path.DirectorySeparatorChar
        return if normalized.StartsWith(root, StringComparison.OrdinalIgnoreCase) || canonical.StartsWith(
            canonicalRoot,
            StringComparison.OrdinalIgnoreCase
        ) {
            normalized
        } else {
            default(string?)
        }
    }

    // Resolves directory symlinks in the path's ancestry (macOS `/tmp` →
    // `/private/tmp`) by round-tripping through the filesystem; falls back to
    // the input when nothing exists to resolve against.
    private func CanonicalizePath(path string) string {
        try {
            let directory = Path.GetDirectoryName(path)
            if string.IsNullOrEmpty(directory) || !Directory.Exists(directory) {
                return path
            }
            let info = DirectoryInfo(directory!!)
            let resolvedDirectory = info.ResolveLinkTarget(returnFinalTarget: true)
                ?.FullName ??
                ResolveAncestrySymlinks(directory!!)
            return Path.Combine(resolvedDirectory, Path.GetFileName(path))
        } catch (e Exception) when e is IOException || e is UnauthorizedAccessException || e is ArgumentException {
            return path
        }
    }

    private func ResolveAncestrySymlinks(directory string) string {
        // `ResolveLinkTarget` only resolves when the FINAL component is the
        // link; `/tmp/foo/bar` needs `/tmp` itself resolved. Walk up until a
        // component resolves, then reattach the remainder.
        var current = directory
        let suffix = List[string]()
        while !string.IsNullOrEmpty(current) {
            if Directory.Exists(current) {
                let resolved string? = DirectoryInfo(current).ResolveLinkTarget(returnFinalTarget: true)?.FullName
                if resolved != nil {
                    suffix.Reverse()
                    var combined = resolved
                    for segment in suffix {
                        combined = Path.Combine(combined, segment)
                    }
                    return combined
                }
            }
            let name = Path.GetFileName(current)
            let parent = Path.GetDirectoryName(current)
            if string.IsNullOrEmpty(name) || string.IsNullOrEmpty(parent) || parent == current {
                break
            }
            suffix.Add(name)
            // The IsNullOrEmpty guard above establishes that parent is non-null.
            current = parent!!
        }
        return directory
    }
}

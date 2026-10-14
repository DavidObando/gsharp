// <copyright file="Fingerprint.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Linq
import System.Security.Cryptography
import System.Text
import System.Text.RegularExpressions

/// Computes the dedup fingerprint that collapses the <i>same gap</i> across
/// corpus apps and runs to a single issue (ADR-0115 §D.2):
/// ```
/// fingerprint = sha256( category + "|" + stage + "|" + diagnostic.id + "|"
/// + offendingCSharpConstruct.kind + "|"
/// + normalizedConstructShape )
/// ```
/// rendered as `"sha256:" + lowercase-hex`. It deliberately excludes
/// `runId`, `corpusAppId`, `gscVersion`, and concrete source
/// positions so the same defect dedups regardless of where/when it surfaced.
/// Test-run failures use (cref:ComputeTestParityFailure) because their
/// stable evidence is a set of failing test identities rather than a source
/// construct shape.
shared class Fingerprint {
    // The normalized-shape length cap (issue #1750): applied to the shape
    // *after* NormalizeShape runs, never to the raw snippet, so the cut point
    // is deterministic on already-normalized text instead of depending on
    // where pre-normalization noise (variable-length identifiers, run-scoped
    // paths, etc.) happened to land.
    private const ShapeMaxLength int32 = 160

    // Absolute paths (issue #1750): any Windows drive/UNC path or Unix
    // absolute path with at least one full directory segment. These routinely
    // embed run-scoped temp/work directories (e.g. a hex run id) whose
    // segment count and character shape differ machine-to-machine and
    // run-to-run, so they must be neutralized generically — not by matching
    // one known prefix — before anything else looks at the text.
    // The Unix branch (issue #1750 N2) requires only a boundary before the
    // leading `/` — not a preceding word character, so it doesn't swallow a
    // bare fraction like `3/4` — then one or more path segments. Unlike the
    // prior version, a single-segment absolute path (e.g. a run-scoped `/tmp`
    // or `/root` with no interior segment) is stripped too.
    private let AbsolutePathPattern Regex = Regex(
        "(?:[A-Za-z]:[\\\\/](?:[^\\s\"'<>|:]+[\\\\/])*[^\\s\"'<>|:]*)" +
            "|(?:\\\\\\\\[^\\s\"'<>|:]+(?:\\\\[^\\s\"'<>|:]+)+)" +
            "|(?:(?<![A-Za-z0-9_])/[^\\s\"'<>|:]+(?:/[^\\s\"'<>|:]*)*)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant
    )

    // Identifiers: a letter/underscore start then word chars. Collapsed to `id`.
    private let IdentifierPattern Regex = Regex(
        "[A-Za-z_][A-Za-z0-9_]*",
        RegexOptions.Compiled | RegexOptions.CultureInvariant
    )

    // String/char/interpolated literals (single- and double-quoted, with simple
    // escape tolerance) and numeric literals. Collapsed to `lit`.
    private let StringLiteralPattern Regex = Regex(
        "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'",
        RegexOptions.Compiled | RegexOptions.CultureInvariant
    )

    private let NumberLiteralPattern Regex = Regex(
        "\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?\\b",
        RegexOptions.Compiled | RegexOptions.CultureInvariant
    )
    private let WhitespacePattern Regex = Regex("\\s+", RegexOptions.Compiled | RegexOptions.CultureInvariant)

    /// Computes the rendered fingerprint string for a failure.
    /// @param category The schema category string (e.g. `compile-error`).
    /// @param stage The schema stage string (e.g. `compile`).
    /// @param diagnosticId The diagnostic id (e.g. `GS0313`).
    /// @param constructKind The offending construct kind.
    /// @param constructSnippet The <i>raw, untruncated</i> construct snippet. Callers must not
    /// pre-truncate this value (issue #1750): the shape is normalized first
    /// and only the normalized shape is length-capped, so the cut point is
    /// deterministic on stable, already-normalized text rather than on
    /// whatever raw text happened to precede it.
    /// @returns The fingerprint, rendered as `"sha256:" + hex`.
    func Compute(
        category string,
        stage string,
        diagnosticId string?,
        constructKind string?,
        constructSnippet string?
    ) string {
        var shape = NormalizeShape(constructSnippet)
        shape = TruncateShape(shape)
        let payload = string.Join(
            "|",
            category ?? string.Empty,
            stage ?? string.Empty,
            diagnosticId ?? string.Empty,
            constructKind ?? string.Empty,
            shape
        )
        return "sha256:" + Hash(payload)
    }

    /// Computes a stage-4 fingerprint from the complete set of failing test
    /// method identities. Identity order, duplicate result lines, theory data,
    /// durations, warnings, paths, and the rest of the process output do not
    /// participate.
    /// @remarks When a completed run does not expose a complete per-test identity set,
    /// the result is explicitly marked `unclassified-test-parity` and
    /// scoped to one corpus app. Such a value is deterministic, but is not a
    /// cross-app shared-cause signal.
    /// @param category The schema category.
    /// @param stage The schema stage.
    /// @param diagnosticId The diagnostic id.
    /// @param failingTestNames The complete reported failing-test name set, or an empty set.
    /// @param fallbackScope The stable corpus-app scope used only when the set is empty.
    /// @returns A classified `sha256:` fingerprint or an explicit unclassified fingerprint.
    func ComputeTestParityFailure(
        category string,
        stage string,
        diagnosticId string?,
        failingTestNames IReadOnlyList[string],
        fallbackScope string
    ) string {
        let identities = (failingTestNames ?? Array.Empty[string]())
            .Select(TestParityAllowList.NormalizeTestName)
            .Select((name string) -> WhitespacePattern.Replace(name, " ").Trim())
            .Where((name string) -> name.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
        if identities.Length == 0 {
            let scope_ = (fallbackScope ?? string.Empty).Trim().Replace('\\', '/')
            let fallbackPayload = string.Join(
                "|",
                category ?? string.Empty,
                stage ?? string.Empty,
                diagnosticId ?? string.Empty,
                "unclassified-app-scope",
                scope_
            )
            return "unclassified-test-parity:sha256:" + Hash(fallbackPayload)
        }
        let payload = string.Join(
            "|",
            category ?? string.Empty,
            stage ?? string.Empty,
            diagnosticId ?? string.Empty,
            "failing-test-identities",
            string.Join("\n", identities)
        )
        return "sha256:" + Hash(payload)
    }

    /// Reduces a construct snippet to its syntactic skeleton: the
    /// `normalizedConstructShape` of §D.2. Rules, applied in order:
    /// 1. absolute file paths (any run/work/temp root, Windows drive/UNC or Unix) → `lit` (issue #1750:
    /// neutralizes run-scoped paths regardless of prefix, before anything else can tokenize them);
    /// 2. string/char/interpolated literals → `lit`;
    /// 3. numeric literals → `lit`;
    /// 4. identifiers and keywords → `id` (strips all names);
    /// 5. runs of whitespace → a single space; trim ends.
    /// Punctuation/operators/brackets are preserved as the structural skeleton.
    /// The result keeps the <i>shape</i> (e.g. `id id[id] = id(id, lit)`)
    /// while erasing the names, numbers, paths, and positions that vary per
    /// occurrence, run, or machine.
    /// @param snippet The raw, untruncated construct snippet.
    /// @returns The normalized syntactic skeleton (not length-capped).
    func NormalizeShape(snippet string?) string {
        if string.IsNullOrEmpty(snippet) {
            return string.Empty
        }
        var text = snippet.Replace("\r\n", "\n")
        // Absolute paths first: a run-scoped temp/work directory (e.g. a hex
        // run id) tokenizes inconsistently once its segments are split by the
        // identifier/number patterns below (a leading digit in the hex id
        // shifts the token boundary), so the whole path must be recognized
        // and collapsed as one opaque unit before that happens.
        text = AbsolutePathPattern.Replace(text, "lit")
        // Literals next so their contents are not mistaken for identifiers.
        text = StringLiteralPattern.Replace(text, "lit")
        text = NumberLiteralPattern.Replace(text, "lit")
        // Every identifier/keyword (now that string/path contents are gone) →
        // `id`. A literal placeholder `lit` is itself an identifier-shaped
        // token, so protect it: replace identifiers except the exact token `lit`.
        text = IdentifierPattern.Replace(
            text,
            func (m Match) string {
                return if m.Value == "lit" {
                    "lit"
                } else {
                    "id"
                }
            }
        )
        text = WhitespacePattern.Replace(text, " ")
        return text.Trim()
    }

    /// Caps the normalized shape length. Applied only after
    /// (cref:NormalizeShape) (issue #1750) so the cut point falls on
    /// deterministic, already-normalized text.
    /// @param shape The normalized shape.
    /// @returns The length-capped shape.
    private func TruncateShape(shape string) string {
        if string.IsNullOrEmpty(shape) || shape.Length <= ShapeMaxLength {
            return shape
        }
        return shape.Substring(0, ShapeMaxLength) + "…"
    }

    private func Hash(payload string) string {
        let hash = SHA256.HashData(Encoding.UTF8.GetBytes(payload))
        return Convert.ToHexString(hash).ToLowerInvariant()
    }
}

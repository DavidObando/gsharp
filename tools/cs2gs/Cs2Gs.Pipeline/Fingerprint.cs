// <copyright file="Fingerprint.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Computes the dedup fingerprint that collapses the <i>same gap</i> across
/// corpus apps and runs to a single issue (ADR-0115 §D.2):
/// <code>
/// fingerprint = sha256( category + "|" + stage + "|" + diagnostic.id + "|"
///                       + offendingCSharpConstruct.kind + "|"
///                       + normalizedConstructShape )
/// </code>
/// rendered as <c>"sha256:" + lowercase-hex</c>. It deliberately excludes
/// <c>runId</c>, <c>corpusAppId</c>, <c>gscVersion</c>, and concrete source
/// positions so the same defect dedups regardless of where/when it surfaced.
/// </summary>
public static class Fingerprint
{
    // The normalized-shape length cap (issue #1750): applied to the shape
    // *after* NormalizeShape runs, never to the raw snippet, so the cut point
    // is deterministic on already-normalized text instead of depending on
    // where pre-normalization noise (variable-length identifiers, run-scoped
    // paths, etc.) happened to land.
    private const int ShapeMaxLength = 160;

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
    private static readonly Regex AbsolutePathPattern = new Regex(
        @"(?:[A-Za-z]:[\\/](?:[^\s""'<>|:]+[\\/])*[^\s""'<>|:]*)" +
        @"|(?:\\\\[^\s""'<>|:]+(?:\\[^\s""'<>|:]+)+)" +
        @"|(?:(?<![A-Za-z0-9_])/[^\s""'<>|:]+(?:/[^\s""'<>|:]*)*)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // Identifiers: a letter/underscore start then word chars. Collapsed to `id`.
    private static readonly Regex IdentifierPattern = new Regex(
        @"[A-Za-z_][A-Za-z0-9_]*",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    // String/char/interpolated literals (single- and double-quoted, with simple
    // escape tolerance) and numeric literals. Collapsed to `lit`.
    private static readonly Regex StringLiteralPattern = new Regex(
        "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex NumberLiteralPattern = new Regex(
        @"\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex WhitespacePattern = new Regex(
        @"\s+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Computes the rendered fingerprint string for a failure.
    /// </summary>
    /// <param name="category">The schema category string (e.g. <c>compile-error</c>).</param>
    /// <param name="stage">The schema stage string (e.g. <c>compile</c>).</param>
    /// <param name="diagnosticId">The diagnostic id (e.g. <c>GS0313</c>).</param>
    /// <param name="constructKind">The offending construct kind.</param>
    /// <param name="constructSnippet">
    /// The <i>raw, untruncated</i> construct snippet. Callers must not
    /// pre-truncate this value (issue #1750): the shape is normalized first
    /// and only the normalized shape is length-capped, so the cut point is
    /// deterministic on stable, already-normalized text rather than on
    /// whatever raw text happened to precede it.
    /// </param>
    /// <returns>The fingerprint, rendered as <c>"sha256:" + hex</c>.</returns>
    public static string Compute(
        string category,
        string stage,
        string diagnosticId,
        string constructKind,
        string constructSnippet)
    {
        string shape = NormalizeShape(constructSnippet);
        shape = TruncateShape(shape);
        string payload = string.Join(
            "|",
            category ?? string.Empty,
            stage ?? string.Empty,
            diagnosticId ?? string.Empty,
            constructKind ?? string.Empty,
            shape);

        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(payload));
        return "sha256:" + Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// Reduces a construct snippet to its syntactic skeleton: the
    /// <c>normalizedConstructShape</c> of §D.2. Rules, applied in order:
    /// <list type="number">
    /// <item><description>absolute file paths (any run/work/temp root, Windows
    /// drive/UNC or Unix) → <c>lit</c> (issue #1750: neutralizes run-scoped
    /// paths regardless of prefix, before anything else can tokenize them);</description></item>
    /// <item><description>string/char/interpolated literals → <c>lit</c>;</description></item>
    /// <item><description>numeric literals → <c>lit</c>;</description></item>
    /// <item><description>identifiers and keywords → <c>id</c> (strips all names);</description></item>
    /// <item><description>runs of whitespace → a single space; trim ends.</description></item>
    /// </list>
    /// Punctuation/operators/brackets are preserved as the structural skeleton.
    /// The result keeps the <i>shape</i> (e.g. <c>id id[id] = id(id, lit)</c>)
    /// while erasing the names, numbers, paths, and positions that vary per
    /// occurrence, run, or machine.
    /// </summary>
    /// <param name="snippet">The raw, untruncated construct snippet.</param>
    /// <returns>The normalized syntactic skeleton (not length-capped).</returns>
    public static string NormalizeShape(string snippet)
    {
        if (string.IsNullOrEmpty(snippet))
        {
            return string.Empty;
        }

        string text = snippet.Replace("\r\n", "\n");

        // Absolute paths first: a run-scoped temp/work directory (e.g. a hex
        // run id) tokenizes inconsistently once its segments are split by the
        // identifier/number patterns below (a leading digit in the hex id
        // shifts the token boundary), so the whole path must be recognized
        // and collapsed as one opaque unit before that happens.
        text = AbsolutePathPattern.Replace(text, "lit");

        // Literals next so their contents are not mistaken for identifiers.
        text = StringLiteralPattern.Replace(text, "lit");
        text = NumberLiteralPattern.Replace(text, "lit");

        // Every identifier/keyword (now that string/path contents are gone) →
        // `id`. A literal placeholder `lit` is itself an identifier-shaped
        // token, so protect it: replace identifiers except the exact token `lit`.
        text = IdentifierPattern.Replace(text, m => m.Value == "lit" ? "lit" : "id");

        text = WhitespacePattern.Replace(text, " ");
        return text.Trim();
    }

    /// <summary>
    /// Caps the normalized shape length. Applied only after
    /// <see cref="NormalizeShape"/> (issue #1750) so the cut point falls on
    /// deterministic, already-normalized text.
    /// </summary>
    /// <param name="shape">The normalized shape.</param>
    /// <returns>The length-capped shape.</returns>
    private static string TruncateShape(string shape)
    {
        if (string.IsNullOrEmpty(shape) || shape.Length <= ShapeMaxLength)
        {
            return shape;
        }

        return shape.Substring(0, ShapeMaxLength) + "…";
    }
}

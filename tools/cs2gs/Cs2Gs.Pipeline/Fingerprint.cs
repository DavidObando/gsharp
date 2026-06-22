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
    /// <param name="constructSnippet">The raw construct snippet (normalized internally).</param>
    /// <returns>The fingerprint, rendered as <c>"sha256:" + hex</c>.</returns>
    public static string Compute(
        string category,
        string stage,
        string diagnosticId,
        string constructKind,
        string constructSnippet)
    {
        string shape = NormalizeShape(constructSnippet);
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
    /// <item><description>string/char/interpolated literals → <c>lit</c>;</description></item>
    /// <item><description>numeric literals → <c>lit</c>;</description></item>
    /// <item><description>identifiers and keywords → <c>id</c> (strips all names);</description></item>
    /// <item><description>runs of whitespace → a single space; trim ends.</description></item>
    /// </list>
    /// Punctuation/operators/brackets are preserved as the structural skeleton.
    /// The result keeps the <i>shape</i> (e.g. <c>id id[id] = id(id, lit)</c>)
    /// while erasing the names, numbers, and positions that vary per occurrence.
    /// </summary>
    /// <param name="snippet">The raw construct snippet.</param>
    /// <returns>The normalized syntactic skeleton.</returns>
    public static string NormalizeShape(string snippet)
    {
        if (string.IsNullOrEmpty(snippet))
        {
            return string.Empty;
        }

        string text = snippet.Replace("\r\n", "\n");

        // Literals first so their contents are not mistaken for identifiers.
        text = StringLiteralPattern.Replace(text, "lit");
        text = NumberLiteralPattern.Replace(text, "lit");

        // Every identifier/keyword (now that string contents are gone) → `id`.
        // A literal placeholder `lit` is itself an identifier-shaped token, so
        // protect it: replace identifiers except the exact token `lit`.
        text = IdentifierPattern.Replace(text, m => m.Value == "lit" ? "lit" : "id");

        text = WhitespacePattern.Replace(text, " ");
        return text.Trim();
    }
}

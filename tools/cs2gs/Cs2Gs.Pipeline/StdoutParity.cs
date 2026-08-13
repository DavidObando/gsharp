// <copyright file="StdoutParity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Tests;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The deterministic stdout-parity oracle for executable corpus apps
/// (ADR-0115 §C/§E): compares the stdout captured from running the migrated G#
/// program against the committed <c>baseline.stdout.golden</c> fixture. The
/// normalization mirrors the L1 end-to-end recipe exactly — CRLF→LF, then a
/// single trailing newline — so only meaningful differences register. On a
/// mismatch the first differing line (1-based) plus both sides are reported so
/// the triage artifact can summarize it.
/// </summary>
public static class StdoutParity
{
    /// <summary>
    /// Compares actual program stdout against the golden baseline.
    /// </summary>
    /// <param name="golden">The committed <c>baseline.stdout.golden</c> text.</param>
    /// <param name="actual">The migrated program's captured stdout.</param>
    /// <returns>The stdout comparison result.</returns>
    public static StdoutParityResult Compare(string golden, string actual)
    {
        GoldenFileComparison comparison = GoldenFile.CompareText(golden, actual, Normalize);
        return FromGoldenComparison(comparison);
    }

    /// <summary>
    /// Compares actual program stdout against a golden baseline file using the
    /// shared snapshot diff, update, and <c>.actual</c> workflow.
    /// </summary>
    /// <param name="goldenPath">The committed <c>baseline.stdout.golden</c> path.</param>
    /// <param name="actual">The migrated program's captured stdout.</param>
    /// <param name="update">
    /// Optional update override. When null, <c>GSHARP_UPDATE_GOLDENS=1</c>
    /// controls update mode.
    /// </param>
    /// <returns>The stdout comparison result.</returns>
    public static StdoutParityResult CompareFile(
        string goldenPath,
        string actual,
        bool? update = null)
    {
        GoldenFileComparison comparison =
            GoldenFile.CompareFile(goldenPath, actual, update, Normalize);
        string guidance = comparison.IsMatch
            ? null
            : GoldenFile.FormatUpdateGuidance(comparison, goldenPath);
        return FromGoldenComparison(comparison, guidance);
    }

    /// <summary>
    /// Normalizes captured text the same way as the L1 end-to-end test: CRLF→LF,
    /// then tolerate exactly one unavoidable terminal newline. Issue #1749 mode
    /// 2: <c>TrimEnd('\n')</c> strips *every* trailing newline, so
    /// <c>"a\n\n\n"</c> and <c>"a\n"</c> normalized equal — a migrated program
    /// that gains/loses trailing blank lines would falsely byte-parity-match.
    /// Stripping at most one trailing newline before re-appending one keeps
    /// that single terminal newline tolerated while any extra trailing blank
    /// line still registers as a real difference.
    /// </summary>
    /// <param name="text">The text to normalize (null treated as empty).</param>
    /// <returns>The normalized text.</returns>
    public static string Normalize(string text)
    {
        string normalized = (text ?? string.Empty).Replace("\r\n", "\n");
        if (normalized.EndsWith("\n", StringComparison.Ordinal))
        {
            normalized = normalized.Substring(0, normalized.Length - 1);
        }

        return normalized + "\n";
    }

    private static StdoutParityResult FromGoldenComparison(
        GoldenFileComparison comparison,
        string guidance = null)
        => comparison.IsMatch
            ? StdoutParityResult.Match()
            : StdoutParityResult.Mismatch(
                comparison.LineNumber,
                comparison.ExpectedLine,
                comparison.ActualLine,
                guidance);
}

/// <summary>
/// The result of a <see cref="StdoutParity.Compare"/> invocation.
/// </summary>
public sealed class StdoutParityResult
{
    private readonly string guidance;

    private StdoutParityResult(
        bool isMatch,
        int lineNumber,
        string expectedLine,
        string actualLine,
        string guidance)
    {
        this.IsMatch = isMatch;
        this.LineNumber = lineNumber;
        this.ExpectedLine = expectedLine;
        this.ActualLine = actualLine;
        this.guidance = guidance;
    }

    /// <summary>Gets a value indicating whether stdout matched the golden.</summary>
    public bool IsMatch { get; }

    /// <summary>Gets the 1-based first differing line number (0 when matched).</summary>
    public int LineNumber { get; }

    /// <summary>Gets the expected (golden) line at the first difference, or null.</summary>
    public string ExpectedLine { get; }

    /// <summary>Gets the actual line at the first difference, or null.</summary>
    public string ActualLine { get; }

    /// <summary>Creates a matching result.</summary>
    /// <returns>A matching <see cref="StdoutParityResult"/>.</returns>
    public static StdoutParityResult Match() =>
        new StdoutParityResult(true, 0, null, null, null);

    /// <summary>Creates a mismatching result.</summary>
    /// <param name="lineNumber">The 1-based first differing line.</param>
    /// <param name="expectedLine">The golden line, or null past its end.</param>
    /// <param name="actualLine">The actual line, or null past its end.</param>
    /// <param name="guidance">Optional snapshot update guidance.</param>
    /// <returns>A mismatching <see cref="StdoutParityResult"/>.</returns>
    public static StdoutParityResult Mismatch(
        int lineNumber,
        string expectedLine,
        string actualLine,
        string guidance = null) =>
        new StdoutParityResult(false, lineNumber, expectedLine, actualLine, guidance);

    /// <summary>
    /// Gets a one-line expected-vs-actual description used in the triage
    /// diagnostic message.
    /// </summary>
    /// <returns>The description.</returns>
    public string Describe()
    {
        string description =
            $"stdout differs at line {this.LineNumber}: expected '{this.ExpectedLine ?? "<end-of-output>"}' " +
            $"but got '{this.ActualLine ?? "<end-of-output>"}'";
        return string.IsNullOrEmpty(this.guidance)
            ? description
            : description + ". " + this.guidance;
    }
}

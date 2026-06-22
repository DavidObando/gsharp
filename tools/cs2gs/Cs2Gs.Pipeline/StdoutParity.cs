// <copyright file="StdoutParity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

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
        string normalizedGolden = Normalize(golden);
        string normalizedActual = Normalize(actual);

        if (string.Equals(normalizedGolden, normalizedActual, StringComparison.Ordinal))
        {
            return StdoutParityResult.Match();
        }

        string[] goldenLines = normalizedGolden.Split('\n');
        string[] actualLines = normalizedActual.Split('\n');
        int max = Math.Max(goldenLines.Length, actualLines.Length);
        for (int i = 0; i < max; i++)
        {
            string expectedLine = i < goldenLines.Length ? goldenLines[i] : null;
            string actualLine = i < actualLines.Length ? actualLines[i] : null;
            if (!string.Equals(expectedLine, actualLine, StringComparison.Ordinal))
            {
                return StdoutParityResult.Mismatch(i + 1, expectedLine, actualLine);
            }
        }

        // Fallback: the strings differ but no per-line difference was isolated.
        return StdoutParityResult.Mismatch(1, normalizedGolden, normalizedActual);
    }

    /// <summary>
    /// Normalizes captured text the same way as the L1 end-to-end test: CRLF→LF
    /// and exactly one trailing newline.
    /// </summary>
    /// <param name="text">The text to normalize (null treated as empty).</param>
    /// <returns>The normalized text.</returns>
    public static string Normalize(string text) =>
        (text ?? string.Empty).Replace("\r\n", "\n").TrimEnd('\n') + "\n";
}

/// <summary>
/// The result of a <see cref="StdoutParity.Compare"/> invocation.
/// </summary>
public sealed class StdoutParityResult
{
    private StdoutParityResult(bool isMatch, int lineNumber, string expectedLine, string actualLine)
    {
        this.IsMatch = isMatch;
        this.LineNumber = lineNumber;
        this.ExpectedLine = expectedLine;
        this.ActualLine = actualLine;
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
    public static StdoutParityResult Match() => new StdoutParityResult(true, 0, null, null);

    /// <summary>Creates a mismatching result.</summary>
    /// <param name="lineNumber">The 1-based first differing line.</param>
    /// <param name="expectedLine">The golden line, or null past its end.</param>
    /// <param name="actualLine">The actual line, or null past its end.</param>
    /// <returns>A mismatching <see cref="StdoutParityResult"/>.</returns>
    public static StdoutParityResult Mismatch(int lineNumber, string expectedLine, string actualLine) =>
        new StdoutParityResult(false, lineNumber, expectedLine, actualLine);

    /// <summary>
    /// Gets a one-line expected-vs-actual description used in the triage
    /// diagnostic message.
    /// </summary>
    /// <returns>The description.</returns>
    public string Describe() =>
        $"stdout differs at line {this.LineNumber}: expected '{this.ExpectedLine ?? "<end-of-output>"}' " +
        $"but got '{this.ActualLine ?? "<end-of-output>"}'";
}

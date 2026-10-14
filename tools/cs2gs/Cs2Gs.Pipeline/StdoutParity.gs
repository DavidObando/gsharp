// <copyright file="StdoutParity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import GSharp.Tests
import System

/// The deterministic stdout-parity oracle for executable corpus apps
/// (ADR-0115 §C/§E): compares the stdout captured from running the migrated G#
/// program against the committed `baseline.stdout.golden` fixture. The
/// normalization mirrors the L1 end-to-end recipe exactly — CRLF→LF, then a
/// single trailing newline — so only meaningful differences register. On a
/// mismatch the first differing line (1-based) plus both sides are reported so
/// the triage artifact can summarize it.
shared class StdoutParity {
    /// Compares actual program stdout against the golden baseline.
    /// @param golden The committed `baseline.stdout.golden` text.
    /// @param actual The migrated program's captured stdout.
    /// @returns The stdout comparison result.
    func Compare(golden string, actual string) StdoutParityResult {
        let comparison = GoldenFile.CompareText(golden, actual, Normalize)
        return FromGoldenComparison(comparison)
    }

    /// Compares actual program stdout against a golden baseline file using the
    /// shared snapshot diff, update, and `.actual` workflow.
    /// @param goldenPath The committed `baseline.stdout.golden` path.
    /// @param actual The migrated program's captured stdout.
    /// @param update Optional update override. When null, `GSHARP_UPDATE_GOLDENS=1`
    /// controls update mode.
    /// @returns The stdout comparison result.
    func CompareFile(goldenPath string?, actual string, update bool? = nil) StdoutParityResult {
        let comparison = GoldenFile.CompareFile(goldenPath, actual, update, Normalize)
        let guidance string? = if comparison.IsMatch {
            default(string?)
        } else {
            GoldenFile.FormatUpdateGuidance(comparison, goldenPath)
        }
        return FromGoldenComparison(comparison, guidance)
    }

    /// Normalizes captured text the same way as the L1 end-to-end test: CRLF→LF,
    /// then tolerate exactly one unavoidable terminal newline. Issue #1749 mode
    /// 2: `TrimEnd('\n')` strips *every* trailing newline, so
    /// `"a\n\n\n"` and `"a\n"` normalized equal — a migrated program
    /// that gains/loses trailing blank lines would falsely byte-parity-match.
    /// Stripping at most one trailing newline before re-appending one keeps
    /// that single terminal newline tolerated while any extra trailing blank
    /// line still registers as a real difference.
    /// @param text The text to normalize (null treated as empty).
    /// @returns The normalized text.
    func Normalize(text string) string {
        var normalized = (text ?? string.Empty).Replace("\r\n", "\n")
        if normalized.EndsWith("\n", StringComparison.Ordinal) {
            normalized = normalized.Substring(0, normalized.Length - 1)
        }
        return normalized + "\n"
    }

    private func FromGoldenComparison(
        comparison GoldenFileComparison,
        guidance string? = nil
    ) StdoutParityResult -> if comparison.IsMatch {
        StdoutParityResult.Match()
    } else {
        StdoutParityResult.Mismatch(comparison.LineNumber, comparison.ExpectedLine, comparison.ActualLine, guidance)
    }
}

/// The result of a (cref:StdoutParity.Compare) invocation.
class StdoutParityResult {
    private let guidance string?

    private init(isMatch bool, lineNumber int32, expectedLine string?, actualLine string?, guidance string?) {
        this.IsMatch = isMatch
        this.LineNumber = lineNumber
        this.ExpectedLine = expectedLine
        this.ActualLine = actualLine
        this.guidance = guidance
    }

    /// Gets a value indicating whether stdout matched the golden.
    prop IsMatch bool {
        get;
    }

    /// Gets the 1-based first differing line number (0 when matched).
    prop LineNumber int32 {
        get;
    }

    /// Gets the expected (golden) line at the first difference, or null.
    prop ExpectedLine string? {
        get;
    }

    /// Gets the actual line at the first difference, or null.
    prop ActualLine string? {
        get;
    }

    /// Gets a one-line expected-vs-actual description used in the triage
    /// diagnostic message.
    /// @returns The description.
    func Describe() string {
        let description = "stdout differs at line ${this.LineNumber}: expected '${this.ExpectedLine ?? "<end-of-output>"}' " +
            "but got '${this.ActualLine ?? "<end-of-output>"}'"
        return if string.IsNullOrEmpty(this.guidance) {
            description
        } else {
            description + ". " + this.guidance
        }
    }

    shared {
        /// Creates a matching result.
        /// @returns A matching (cref:StdoutParityResult).
        func Match() StdoutParityResult -> StdoutParityResult(true, 0, nil, nil, nil)

        /// Creates a mismatching result.
        /// @param lineNumber The 1-based first differing line.
        /// @param expectedLine The golden line, or null past its end.
        /// @param actualLine The actual line, or null past its end.
        /// @param guidance Optional snapshot update guidance.
        /// @returns A mismatching (cref:StdoutParityResult).
        func Mismatch(
            lineNumber int32,
            expectedLine string?,
            actualLine string?,
            guidance string? = nil
        ) StdoutParityResult -> StdoutParityResult(false, lineNumber, expectedLine, actualLine, guidance)
    }
}

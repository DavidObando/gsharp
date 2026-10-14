// <copyright file="GoldenFile.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests

import System
import System.IO

internal shared class GoldenFile {
    private const UpdateEnvironmentVariable string = "GSHARP_UPDATE_GOLDENS"

    func AssertMatches(goldenPath string?, actual string, guidance string? = nil, update bool? = nil) {
        let comparison = CompareFile(goldenPath, actual, update)
        if !comparison.IsMatch {
            throw GoldenFileException(FormatFailure(comparison, goldenPath!!, guidance))
        }
    }

    func CompareFile(
        goldenPath string?,
        actual string,
        update bool? = nil,
        normalize((string) -> string)? = nil
    ) GoldenFileComparison {
        let normalizeText = normalize ?? Normalize
        let normalizedActual = normalizeText(actual) ?? string.Empty
        let shouldUpdate = ShouldUpdate(update, Environment.GetEnvironmentVariable(UpdateEnvironmentVariable))
        if shouldUpdate {
            EnsureDirectory(goldenPath)
            File.WriteAllText(goldenPath!!, normalizedActual)
            return GoldenFileComparison.Match()
        }
        if !File.Exists(goldenPath) {
            let missingActualPath = WriteActual(goldenPath, normalizedActual)
            let actualLine = normalizedActual.Split('\n')[0]
            return GoldenFileComparison.Missing(missingActualPath, actualLine)
        }
        let normalizedExpected = normalizeText(File.ReadAllText(goldenPath)) ?? string.Empty
        let comparison = CompareNormalized(normalizedExpected, normalizedActual)
        return if comparison.IsMatch {
            comparison
        } else {
            comparison.WithActualPath(WriteActual(goldenPath, normalizedActual))
        }
    }

    func CompareText(expected string, actual string, normalize((string) -> string)? = nil) GoldenFileComparison {
        let normalizeText = normalize ?? Normalize
        return CompareNormalized(normalizeText(expected) ?? string.Empty, normalizeText(actual) ?? string.Empty)
    }

    func Normalize(text string) string -> (text ?? string.Empty).ReplaceLineEndings("\n")

    func FormatUpdateGuidance(comparison GoldenFileComparison, goldenPath string?) string {
        if comparison.IsMatch {
            return string.Empty
        }
        let missing = if comparison.IsMissing {
            "Missing golden at `$goldenPath`. "
        } else {
            string.Empty
        }
        return missing +
            "Wrote generated output to `${comparison.ActualPath}`. " +
            "Set $UpdateEnvironmentVariable=1 to update in place."
    }

    internal func ShouldUpdate(update bool?, environmentValue string?) bool -> update ?? string.Equals(
        environmentValue,
        "1",
        StringComparison.Ordinal
    )

    private func FormatFailure(comparison GoldenFileComparison, goldenPath string, guidance string?) string {
        let difference = if comparison.IsMissing {
            string.Empty
        } else {
            "Golden mismatch at line ${comparison.LineNumber}: " +
                "expected `${comparison.ExpectedLine ?? "<end-of-file>"}`, " +
                "actual `${comparison.ActualLine ?? "<end-of-file>"}`. "
        }
        return difference + FormatUpdateGuidance(comparison, goldenPath) + FormatGuidance(guidance)
    }

    private func WriteActual(goldenPath string?, actual string) string {
        let actualPath = goldenPath + ".actual"
        EnsureDirectory(actualPath)
        File.WriteAllText(actualPath, actual)
        return actualPath
    }

    private func EnsureDirectory(path string?) {
        let directory string? = Path.GetDirectoryName(path)
        if !string.IsNullOrEmpty(directory) {
            Directory.CreateDirectory(directory)
        }
    }

    private func CompareNormalized(expected string, actual string) GoldenFileComparison {
        if string.Equals(expected, actual, StringComparison.Ordinal) {
            return GoldenFileComparison.Match()
        }
        let expectedLines = expected.Split('\n')
        let actualLines = actual.Split('\n')
        let count = Math.Max(expectedLines.Length, actualLines.Length)
        for var i = 0; i < count; i++ {
            let expectedLine string? = if i < expectedLines.Length {
                expectedLines[i]
            } else {
                default(string?)
            }
            let actualLine string? = if i < actualLines.Length {
                actualLines[i]
            } else {
                default(string?)
            }
            if !string.Equals(expectedLine, actualLine, StringComparison.Ordinal) {
                return GoldenFileComparison.Mismatch(i + 1, expectedLine, actualLine)
            }
        }
        return GoldenFileComparison.Mismatch(1, expected, actual)
    }

    private func FormatGuidance(guidance string?) string -> if string.IsNullOrWhiteSpace(guidance) {
        string.Empty
    } else {
        Environment.NewLine + guidance
    }
}

internal class GoldenFileComparison {
    private init(
        isMatch bool,
        isMissing bool,
        lineNumber int32,
        expectedLine string?,
        actualLine string?,
        actualPath string?
    ) {
        this.IsMatch = isMatch
        this.IsMissing = isMissing
        this.LineNumber = lineNumber
        this.ExpectedLine = expectedLine
        this.ActualLine = actualLine
        this.ActualPath = actualPath
    }

    prop IsMatch bool {
        get;
    }

    prop IsMissing bool {
        get;
    }

    prop LineNumber int32 {
        get;
    }

    prop ExpectedLine string? {
        get;
    }

    prop ActualLine string? {
        get;
    }

    prop ActualPath string? {
        get;
    }

    func WithActualPath(actualPath string) GoldenFileComparison -> GoldenFileComparison(
        this.IsMatch,
        this.IsMissing,
        this.LineNumber,
        this.ExpectedLine,
        this.ActualLine,
        actualPath
    )

    shared {
        func Match() GoldenFileComparison -> GoldenFileComparison(true, false, 0, nil, nil, nil)

        func Missing(actualPath string, actualLine string) GoldenFileComparison -> GoldenFileComparison(
            false,
            true,
            1,
            nil,
            actualLine,
            actualPath
        )

        func Mismatch(
            lineNumber int32,
            expectedLine string?,
            actualLine string?
        ) GoldenFileComparison -> GoldenFileComparison(false, false, lineNumber, expectedLine, actualLine, nil)
    }
}

internal class GoldenFileException : Exception {
    init(message string) : base(message) { }
}

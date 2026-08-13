// <copyright file="GoldenFile.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace GSharp.Tests;

internal static class GoldenFile
{
    private const string UpdateEnvironmentVariable = "GSHARP_UPDATE_GOLDENS";

    public static void AssertMatches(
        string goldenPath,
        string actual,
        string guidance = null,
        bool? update = null)
    {
        GoldenFileComparison comparison = CompareFile(goldenPath, actual, update);
        if (!comparison.IsMatch)
        {
            throw new GoldenFileException(FormatFailure(comparison, goldenPath, guidance));
        }
    }

    public static GoldenFileComparison CompareFile(
        string goldenPath,
        string actual,
        bool? update = null,
        Func<string, string> normalize = null)
    {
        Func<string, string> normalizeText = normalize ?? Normalize;
        string normalizedActual = normalizeText(actual) ?? string.Empty;
        bool shouldUpdate = ShouldUpdate(
            update,
            Environment.GetEnvironmentVariable(UpdateEnvironmentVariable));
        if (shouldUpdate)
        {
            EnsureDirectory(goldenPath);
            File.WriteAllText(goldenPath, normalizedActual);
            return GoldenFileComparison.Match();
        }

        if (!File.Exists(goldenPath))
        {
            string missingActualPath = WriteActual(goldenPath, normalizedActual);
            string actualLine = normalizedActual.Split('\n')[0];
            return GoldenFileComparison.Missing(missingActualPath, actualLine);
        }

        string normalizedExpected = normalizeText(File.ReadAllText(goldenPath)) ?? string.Empty;
        GoldenFileComparison comparison = CompareNormalized(normalizedExpected, normalizedActual);
        return comparison.IsMatch
            ? comparison
            : comparison.WithActualPath(WriteActual(goldenPath, normalizedActual));
    }

    public static GoldenFileComparison CompareText(
        string expected,
        string actual,
        Func<string, string> normalize = null)
    {
        Func<string, string> normalizeText = normalize ?? Normalize;
        return CompareNormalized(
            normalizeText(expected) ?? string.Empty,
            normalizeText(actual) ?? string.Empty);
    }

    public static string Normalize(string text)
        => (text ?? string.Empty).ReplaceLineEndings("\n");

    public static string FormatUpdateGuidance(
        GoldenFileComparison comparison,
        string goldenPath)
    {
        if (comparison.IsMatch)
        {
            return string.Empty;
        }

        string missing = comparison.IsMissing
            ? $"Missing golden at `{goldenPath}`. "
            : string.Empty;
        return missing
            + $"Wrote generated output to `{comparison.ActualPath}`. "
            + $"Set {UpdateEnvironmentVariable}=1 to update in place.";
    }

    internal static bool ShouldUpdate(bool? update, string environmentValue)
        => update ?? string.Equals(environmentValue, "1", StringComparison.Ordinal);

    private static string FormatFailure(
        GoldenFileComparison comparison,
        string goldenPath,
        string guidance)
    {
        string difference = comparison.IsMissing
            ? string.Empty
            : $"Golden mismatch at line {comparison.LineNumber}: "
                + $"expected `{comparison.ExpectedLine ?? "<end-of-file>"}`, "
                + $"actual `{comparison.ActualLine ?? "<end-of-file>"}`. ";
        return difference
            + FormatUpdateGuidance(comparison, goldenPath)
            + FormatGuidance(guidance);
    }

    private static string WriteActual(string goldenPath, string actual)
    {
        string actualPath = goldenPath + ".actual";
        EnsureDirectory(actualPath);
        File.WriteAllText(actualPath, actual);
        return actualPath;
    }

    private static void EnsureDirectory(string path)
    {
        string directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
    }

    private static GoldenFileComparison CompareNormalized(
        string expected,
        string actual)
    {
        if (string.Equals(expected, actual, StringComparison.Ordinal))
        {
            return GoldenFileComparison.Match();
        }

        string[] expectedLines = expected.Split('\n');
        string[] actualLines = actual.Split('\n');
        int count = Math.Max(expectedLines.Length, actualLines.Length);
        for (int i = 0; i < count; i++)
        {
            string expectedLine = i < expectedLines.Length ? expectedLines[i] : null;
            string actualLine = i < actualLines.Length ? actualLines[i] : null;
            if (!string.Equals(expectedLine, actualLine, StringComparison.Ordinal))
            {
                return GoldenFileComparison.Mismatch(i + 1, expectedLine, actualLine);
            }
        }

        return GoldenFileComparison.Mismatch(1, expected, actual);
    }

    private static string FormatGuidance(string guidance)
        => string.IsNullOrWhiteSpace(guidance) ? string.Empty : Environment.NewLine + guidance;
}

internal sealed class GoldenFileComparison
{
    private GoldenFileComparison(
        bool isMatch,
        bool isMissing,
        int lineNumber,
        string expectedLine,
        string actualLine,
        string actualPath)
    {
        this.IsMatch = isMatch;
        this.IsMissing = isMissing;
        this.LineNumber = lineNumber;
        this.ExpectedLine = expectedLine;
        this.ActualLine = actualLine;
        this.ActualPath = actualPath;
    }

    public bool IsMatch { get; }

    public bool IsMissing { get; }

    public int LineNumber { get; }

    public string ExpectedLine { get; }

    public string ActualLine { get; }

    public string ActualPath { get; }

    public static GoldenFileComparison Match()
        => new GoldenFileComparison(true, false, 0, null, null, null);

    public static GoldenFileComparison Missing(string actualPath, string actualLine)
        => new GoldenFileComparison(false, true, 1, null, actualLine, actualPath);

    public static GoldenFileComparison Mismatch(
        int lineNumber,
        string expectedLine,
        string actualLine)
        => new GoldenFileComparison(false, false, lineNumber, expectedLine, actualLine, null);

    public GoldenFileComparison WithActualPath(string actualPath)
        => new GoldenFileComparison(
            this.IsMatch,
            this.IsMissing,
            this.LineNumber,
            this.ExpectedLine,
            this.ActualLine,
            actualPath);
}

internal sealed class GoldenFileException : Exception
{
    public GoldenFileException(string message)
        : base(message)
    {
    }
}

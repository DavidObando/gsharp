// <copyright file="GoldenFile.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Tests;

internal static class GoldenFile
{
    private const string UpdateEnvironmentVariable = "GSHARP_UPDATE_GOLDENS";

    public static void AssertMatches(string goldenPath, string actual, string guidance = null)
    {
        string normalizedActual = Normalize(actual);
        if (Environment.GetEnvironmentVariable(UpdateEnvironmentVariable) == "1")
        {
            EnsureDirectory(goldenPath);
            File.WriteAllText(goldenPath, normalizedActual);
            return;
        }

        if (!File.Exists(goldenPath))
        {
            string missingActualPath = WriteActual(goldenPath, normalizedActual);
            Assert.Fail(
                $"Missing golden at `{goldenPath}`. Wrote generated output to `{missingActualPath}`."
                + FormatGuidance(guidance));
        }

        string expected = Normalize(File.ReadAllText(goldenPath));
        if (string.Equals(expected, normalizedActual, StringComparison.Ordinal))
        {
            return;
        }

        string actualPath = WriteActual(goldenPath, normalizedActual);
        var difference = FindFirstDifference(expected, normalizedActual);
        Assert.Fail(
            $"Golden mismatch at line {difference.LineNumber}: expected `{difference.Expected}`, "
            + $"actual `{difference.Actual}`. Wrote generated output to `{actualPath}`. "
            + $"Set {UpdateEnvironmentVariable}=1 to update in place."
            + FormatGuidance(guidance));
    }

    public static string Normalize(string text)
        => (text ?? string.Empty).ReplaceLineEndings("\n");

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

    private static (int LineNumber, string Expected, string Actual) FindFirstDifference(
        string expected,
        string actual)
    {
        string[] expectedLines = expected.Split('\n');
        string[] actualLines = actual.Split('\n');
        int count = Math.Max(expectedLines.Length, actualLines.Length);
        for (int i = 0; i < count; i++)
        {
            string expectedLine = i < expectedLines.Length ? expectedLines[i] : "<end-of-file>";
            string actualLine = i < actualLines.Length ? actualLines[i] : "<end-of-file>";
            if (!string.Equals(expectedLine, actualLine, StringComparison.Ordinal))
            {
                return (i + 1, expectedLine, actualLine);
            }
        }

        return (1, expected, actual);
    }

    private static string FormatGuidance(string guidance)
        => string.IsNullOrWhiteSpace(guidance) ? string.Empty : Environment.NewLine + guidance;
}

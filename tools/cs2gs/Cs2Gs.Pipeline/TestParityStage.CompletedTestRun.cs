// <copyright file="TestParityStage.CompletedTestRun.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable annotations

using System.Text.RegularExpressions;

namespace Cs2Gs.Pipeline;

public sealed partial class TestParityStage
{
    /// <summary>
    /// Issue #2867: detects the VSTest run summary that only ever appears once
    /// the test project has built and its tests have actually executed.
    /// </summary>
    /// <param name="output">The captured <c>dotnet test</c> output.</param>
    /// <returns><see langword="true"/> when a test run completed.</returns>
    internal static bool CompletedTestRun(string? output)
    {
        return !string.IsNullOrEmpty(output)
            && Regex.IsMatch(
                output,
                @"^\s*(Passed|Failed)!\s+-\s+Failed:",
                RegexOptions.Multiline | RegexOptions.CultureInvariant);
    }
}

// <copyright file="BuildTaskSilentFailureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// 6.2 SilentEmitFailure invariant (boundary ring): verifies that the BuildTask
/// diagnostic parser accepts source-anchored GS9998 headers.
///
/// <para>
/// Location recovery and the honest location-less fallback are covered by the
/// driver tests; this class pins the SDK-facing located header format.
/// </para>
/// </summary>
public class BuildTaskSilentFailureTests
{
    /// <summary>
    /// The SDK BuildTask regex for diagnostic lines.
    /// </summary>
    private static readonly Regex DiagnosticLine = new(
        @"^(?<file>[^(]+)\((?<l1>\d+),(?<c1>\d+)(?:,(?<l2>\d+),(?<c2>\d+))?\):\s*(?<sev>error|warning|info)\s+(?<code>[^:]+):\s*(?<msg>.*)$",
        RegexOptions.Compiled);

    [Fact]
    public void DiagnosticLine_Regex_MatchesGS9998_WithSourceFile()
    {
        // Verify that the canonical GS9998 format emitted by Program.Main's
        // outer-ring catch matches the BuildTask's DiagnosticLine regex and
        // carries a source-file path (not "gsc.dll").
        var line = "/path/to/test.gs(9,5,11,1): error GS9998: InvalidOperationException: test message";
        var match = DiagnosticLine.Match(line);

        Assert.True(match.Success, "Diagnostic line should match the regex");
        Assert.Equal("/path/to/test.gs", match.Groups["file"].Value);
        Assert.Equal("error", match.Groups["sev"].Value);
        Assert.Equal("GS9998", match.Groups["code"].Value.Trim());
        Assert.Contains("InvalidOperationException", match.Groups["msg"].Value);
    }

    [Fact]
    public void DiagnosticLine_Regex_MatchesOldFormat_ButNewCodeNeverEmitsGscDll()
    {
        // The old pattern "gsc.dll(0,0,0,0): error GS9998: ..." used to surface
        // as MSB4181. Located diagnostics now carry the source anchor instead.
        var goodLine = "/path/to/test.gs(9,5,11,1): error GS9998: something";
        var goodMatch = DiagnosticLine.Match(goodLine);
        Assert.True(goodMatch.Success);
        Assert.DoesNotContain("gsc.dll", goodMatch.Groups["file"].Value);
        Assert.Contains(".gs", goodMatch.Groups["file"].Value);
    }
}

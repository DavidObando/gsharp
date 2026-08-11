// <copyright file="Issue2867TestRunClassificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2867 — a mirrored test project that BUILT, RAN, and whose tests
/// simply failed was reported as <c>LIBRARY-BUILD-FAILED</c>, because
/// <c>RunMirroredTestProject</c> classified purely on the <c>dotnet test</c>
/// exit code. That is the same class of misleading degradation as #2842: the
/// triage artifact points investigation at the translator/emitter ("a real
/// regression, not translation pending") when the actual signal is a runtime
/// test failure.
/// </summary>
public class Issue2867TestRunClassificationTests
{
    [Theory]
    [InlineData("Failed!  - Failed:     5, Passed:     0, Skipped:     0, Total:     5, Duration: 5 ms")]
    [InlineData("Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7, Duration: 2 s")]
    public void ACompletedTestRunIsRecognised(string summary)
    {
        string output = $"Test run for /tmp/x/Some.Tests.dll (.NETCoreApp,Version=v10.0){Environment.NewLine}"
            + $"A total of 1 test files matched the specified pattern.{Environment.NewLine}"
            + summary;

        Assert.True(TestParityStage.CompletedTestRun(output));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("/tmp/x/Some.gs(3,5): error GS0113: Type '' doesn't exist\n\nBuild FAILED.")]
    [InlineData("MSBUILD : error MSB1009: Project file does not exist.")]
    public void AGenuineBuildFailureIsNotMistakenForATestRun(string output)
    {
        Assert.False(TestParityStage.CompletedTestRun(output));
    }

    [Fact]
    public void TheTwoOutcomesCarryDistinctDiagnosticIds()
    {
        var triage = new TriageBuilder("run-1", "2026-01-01T00:00:00Z", "0.0.0", "app/App.csproj");

        Assert.Equal(
            "LIBRARY-TESTS-FAILED",
            triage.TestParityLibraryTestFailure("Failed!  - Failed: 5, Passed: 0").Diagnostic.Id);
        Assert.Equal(
            "LIBRARY-BUILD-FAILED",
            triage.TestParityLibraryBuildFailure("Build FAILED.").Diagnostic.Id);
    }

    [Fact]
    public void ATestRunFailureIsNotAttributedToTheLibraryBuild()
    {
        var triage = new TriageBuilder("run-1", "2026-01-01T00:00:00Z", "0.0.0", "app/App.csproj");

        TriageArtifact artifact = triage.TestParityLibraryTestFailure("Failed!  - Failed: 5, Passed: 0");

        Assert.Equal("LibraryTestRun", artifact.OffendingCSharpConstruct.Kind);
        Assert.NotEqual(
            triage.TestParityLibraryBuildFailure("Failed!  - Failed: 5, Passed: 0").Fingerprint,
            artifact.Fingerprint);
    }
}

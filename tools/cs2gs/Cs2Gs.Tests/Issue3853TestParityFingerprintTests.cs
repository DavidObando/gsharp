// <copyright file="Issue3853TestParityFingerprintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3853: completed mirrored-test failures fingerprint on stable failing
/// test identities, not the shared stage/id or noisy process output.
/// </summary>
public class Issue3853TestParityFingerprintTests
{
    [Fact]
    public void UnrelatedFailingTestsProduceDifferentFingerprints()
    {
        TriageArtifact first = Artifact(
            "test/First.Tests/First.Tests.csproj",
            Output("First.Tests.ParserTests.RejectsInvalidToken"));
        TriageArtifact second = Artifact(
            "test/Second.Tests/Second.Tests.csproj",
            Output("Second.Tests.RuntimeTests.PreservesNullableValue"));

        Assert.NotEqual(first.Fingerprint, second.Fingerprint);
    }

    [Fact]
    public void ReorderedEquivalentFailuresProduceTheSameFingerprint()
    {
        TriageArtifact first = Artifact(
            "test/Sample.Tests/Sample.Tests.csproj",
            Output("Sample.Tests.A", "Sample.Tests.B"));
        TriageArtifact reordered = Artifact(
            "test/Sample.Tests/Sample.Tests.csproj",
            Output("Sample.Tests.B", "Sample.Tests.A"));

        Assert.Equal(first.Fingerprint, reordered.Fingerprint);
    }

    [Fact]
    public void AmbientWarningsAndRunNoiseDoNotAffectTheFingerprint()
    {
        const string Test = "Sample.Tests.RuntimeTests.ReturnsExpectedValue";
        string first =
            "warning: token abc123 in /Users/runner/work/run-1/build.props\n" +
            OutputWithDuration(Test, "14 ms");
        string second =
            "warning: a different advisory in C:\\agent\\run-99\\build.props\n" +
            OutputWithDuration(Test, "8 s");

        Assert.Equal(
            Artifact("test/Sample.Tests/Sample.Tests.csproj", first).Fingerprint,
            Artifact("test/Sample.Tests/Sample.Tests.csproj", second).Fingerprint);
    }

    [Fact]
    public void FailureIdentityNormalizationIsDeterministic()
    {
        TriageArtifact first = Artifact(
            "test/Sample.Tests/Sample.Tests.csproj",
            OutputWithDuration("Sample.Tests.Theory(value: 1, secret: \"alpha\")", "1 ms"));
        TriageArtifact second = Artifact(
            "test/Sample.Tests/Sample.Tests.csproj",
            OutputWithDuration("  Sample.Tests.Theory(value: 999, secret: \"beta\")  ", "9 s"));

        Assert.Equal(first.Fingerprint, second.Fingerprint);
        Assert.StartsWith("sha256:", first.Fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void MissingStructuredFailuresUsesExplicitAppScopedFallback()
    {
        const string OutputWithoutNames =
            "Failed!  - Failed: 2, Passed: 0, Skipped: 0, Total: 2, Duration: 1 s";

        TriageArtifact first = Artifact(
            "test/First.Tests/First.Tests.csproj",
            OutputWithoutNames);
        TriageArtifact sameApp = Artifact(
            "test/First.Tests/First.Tests.csproj",
            OutputWithoutNames + "\nwarning: unrelated noise");
        TriageArtifact otherApp = Artifact(
            "test/Second.Tests/Second.Tests.csproj",
            OutputWithoutNames);

        Assert.StartsWith(
            "unclassified-test-parity:sha256:",
            first.Fingerprint,
            StringComparison.Ordinal);
        Assert.Equal(first.Fingerprint, sameApp.Fingerprint);
        Assert.NotEqual(first.Fingerprint, otherApp.Fingerprint);
        Assert.Contains(
            "equality with another fingerprint does not imply a shared cause",
            first.Diagnostic.Message,
            StringComparison.Ordinal);
    }

    private static TriageArtifact Artifact(string appId, string output) =>
        new TriageBuilder("run-1", "2026-09-06T00:00:00Z", "0.0.0", appId)
            .TestParityLibraryTestFailure(output);

    private static string Output(params string[] failingTests) =>
        Output(failingTests, "1 ms");

    private static string OutputWithDuration(string failingTest, string duration) =>
        Output(new[] { failingTest }, duration);

    private static string Output(string[] failingTests, string duration)
    {
        string failures = string.Join(
            Environment.NewLine,
            Array.ConvertAll(failingTests, test => $"  Failed {test} [{duration}]"));
        return failures + Environment.NewLine +
            $"Failed!  - Failed: {failingTests.Length}, Passed: 0, Skipped: 0, " +
            $"Total: {failingTests.Length}, Duration: {duration}";
    }
}

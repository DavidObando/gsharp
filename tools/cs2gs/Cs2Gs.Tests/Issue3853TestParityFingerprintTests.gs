// <copyright file="Issue3853TestParityFingerprintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import Xunit

/// Issue #3853: completed mirrored-test failures fingerprint on stable failing
/// test identities, not the shared stage/id or noisy process output.
open class Issue3853TestParityFingerprintTests {
    @Fact
    func UnrelatedFailingTestsProduceDifferentFingerprints() {
        let first = Artifact(
            "test/First.Tests/First.Tests.csproj",
            Output("First.Tests.ParserTests.RejectsInvalidToken")
        )
        let second = Artifact(
            "test/Second.Tests/Second.Tests.csproj",
            Output("Second.Tests.RuntimeTests.PreservesNullableValue")
        )
        Assert.NotEqual(first.Fingerprint, second.Fingerprint)
    }

    @Fact
    func ReorderedEquivalentFailuresProduceTheSameFingerprint() {
        let first = Artifact("test/Sample.Tests/Sample.Tests.csproj", Output("Sample.Tests.A", "Sample.Tests.B"))
        let reordered = Artifact("test/Sample.Tests/Sample.Tests.csproj", Output("Sample.Tests.B", "Sample.Tests.A"))
        Assert.Equal(first.Fingerprint, reordered.Fingerprint)
    }

    @Fact
    func AmbientWarningsAndRunNoiseDoNotAffectTheFingerprint() {
        const Test = "Sample.Tests.RuntimeTests.ReturnsExpectedValue"
        let first = "warning: token abc123 in /Users/runner/work/run-1/build.props\n" +
            OutputWithDuration(Test, "14 ms")
        let second = "warning: a different advisory in C:\\agent\\run-99\\build.props\n" +
            OutputWithDuration(Test, "8 s")
        Assert.Equal(
            Artifact("test/Sample.Tests/Sample.Tests.csproj", first).Fingerprint,
            Artifact("test/Sample.Tests/Sample.Tests.csproj", second).Fingerprint
        )
    }

    @Fact
    func FailureIdentityNormalizationIsDeterministic() {
        let first = Artifact(
            "test/Sample.Tests/Sample.Tests.csproj",
            OutputWithDuration("Sample.Tests.Theory(value: 1, secret: \"alpha\")", "1 ms")
        )
        let second = Artifact(
            "test/Sample.Tests/Sample.Tests.csproj",
            OutputWithDuration("  Sample.Tests.Theory(value: 999, secret: \"beta\")  ", "9 s")
        )
        Assert.Equal(first.Fingerprint, second.Fingerprint)
        Assert.StartsWith("sha256:", first.Fingerprint, StringComparison.Ordinal)
    }

    @Fact
    func MissingStructuredFailuresUsesExplicitAppScopedFallback() {
        const OutputWithoutNames = "Failed!  - Failed: 2, Passed: 0, Skipped: 0, Total: 2, Duration: 1 s"
        let first = Artifact("test/First.Tests/First.Tests.csproj", OutputWithoutNames)
        let sameApp = Artifact("test/First.Tests/First.Tests.csproj", OutputWithoutNames + "\nwarning: unrelated noise")
        let otherApp = Artifact("test/Second.Tests/Second.Tests.csproj", OutputWithoutNames)
        Assert.StartsWith("unclassified-test-parity:sha256:", first.Fingerprint, StringComparison.Ordinal)
        Assert.Equal(first.Fingerprint, sameApp.Fingerprint)
        Assert.NotEqual(first.Fingerprint, otherApp.Fingerprint)
        Assert.Contains(
            "equality with another fingerprint does not imply a shared cause",
            first.Diagnostic!!.Message,
            StringComparison.Ordinal
        )
    }

    shared {
        private func Artifact(appId string, output string) TriageArtifact -> TriageBuilder(
            "run-1",
            "2026-09-06T00:00:00Z",
            "0.0.0",
            appId
        ).TestParityLibraryTestFailure(output)

        private func Output(failingTests ...string) string -> Output(failingTests, "1 ms")

        private func OutputWithDuration(failingTest string, duration string) string -> Output(
            []string{failingTest},
            duration
        )

        private func Output(failingTests[]string, duration string) string {
            let failures = string.Join(
                Environment.NewLine,
                Array.ConvertAll(failingTests, (test string) -> "  Failed $test [$duration]")
            )
            return failures +
                Environment.NewLine +
                "Failed!  - Failed: ${failingTests.Length}, Passed: 0, Skipped: 0, " +
                "Total: ${failingTests.Length}, Duration: $duration"
        }
    }
}

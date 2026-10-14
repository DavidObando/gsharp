// <copyright file="Issue2867TestRunClassificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import Xunit

/// Issue #2867 — a mirrored test project that BUILT, RAN, and whose tests
/// simply failed was reported as `LIBRARY-BUILD-FAILED`, because
/// `RunMirroredTestProject` classified purely on the `dotnet test`
/// exit code. That is the same class of misleading degradation as #2842: the
/// triage artifact points investigation at the translator/emitter ("a real
/// regression, not translation pending") when the actual signal is a runtime
/// test failure.
open class Issue2867TestRunClassificationTests {
    @Theory
    @InlineData("Failed!  - Failed:     5, Passed:     0, Skipped:     0, Total:     5, Duration: 5 ms")
    @InlineData("Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7, Duration: 2 s")
    func ACompletedTestRunIsRecognised(summary string) {
        let output = "Test run for /tmp/x/Some.Tests.dll (.NETCoreApp,Version=v10.0)${Environment.NewLine}" +
            "A total of 1 test files matched the specified pattern.${Environment.NewLine}" +
            summary
        Assert.True(TestParityStage.CompletedTestRun(output))
    }

    @Theory
    @InlineData(nil)
    @InlineData("")
    @InlineData(`/tmp/x/Some.gs(3,5): error GS0113: Type '' doesn't exist

Build FAILED.`)
    @InlineData("MSBUILD : error MSB1009: Project file does not exist.")
    func AGenuineBuildFailureIsNotMistakenForATestRun(output string?) {
        Assert.False(TestParityStage.CompletedTestRun(output))
    }

    @Fact
    func TheTwoOutcomesCarryDistinctDiagnosticIds() {
        let triage = TriageBuilder("run-1", "2026-01-01T00:00:00Z", "0.0.0", "app/App.csproj")
        Assert.Equal(
            "LIBRARY-TESTS-FAILED",
            triage.TestParityLibraryTestFailure("Failed!  - Failed: 5, Passed: 0").Diagnostic!!.Id
        )
        Assert.Equal("LIBRARY-BUILD-FAILED", triage.TestParityLibraryBuildFailure("Build FAILED.").Diagnostic!!.Id)
    }

    @Fact
    func ATestRunFailureIsNotAttributedToTheLibraryBuild() {
        let triage = TriageBuilder("run-1", "2026-01-01T00:00:00Z", "0.0.0", "app/App.csproj")
        let artifact = triage.TestParityLibraryTestFailure("Failed!  - Failed: 5, Passed: 0")
        Assert.Equal("LibraryTestRun", artifact.OffendingCSharpConstruct!!.Kind)
        Assert.NotEqual(
            triage.TestParityLibraryBuildFailure("Failed!  - Failed: 5, Passed: 0").Fingerprint,
            artifact.Fingerprint
        )
    }
}

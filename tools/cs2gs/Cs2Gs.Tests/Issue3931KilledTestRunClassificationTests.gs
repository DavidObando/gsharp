// <copyright file="Issue3931KilledTestRunClassificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import Xunit

/// Issue #3931: a mirrored `dotnet test` run that is KILLED on the
/// wall-clock budget produces no run summary — only the partial `[FAIL]`
/// list printed before the kill. That output has exactly the shape of a
/// project that never built, so the stage filed it as
/// `LIBRARY-BUILD-FAILED`: a hang and a translator regression looked
/// identical, and the truncated `[FAIL]` list read as a parity count when
/// it is only "the failures that happened first". Both halves are proved here:
/// a killed run must be named a timeout, and a genuine build failure must
/// still be named a build failure.
class Issue3931KilledTestRunClassificationTests {
    @Fact
    func KilledRun_IsNamedATimeout_NotABuildFailure() {
        let context = Issue3931KilledTestRunClassificationTests.Context()
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(-1, KilledRunOutput, string.Empty, true)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-TESTS-TIMED-OUT")
        Assert.DoesNotContain(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-BUILD-FAILED")
        // The artifact must SAY the output is truncated, so a reader cannot
        // mistake the surviving [FAIL] lines for a parity count.
        Assert.Contains("TRUNCATED", Assert.Single(outcome.Artifacts).Diagnostic!!.Message, StringComparison.Ordinal)
    }

    /// The other direction: a run that really did fail to build — no summary
    /// line, but also no kill — must keep its `LIBRARY-BUILD-FAILED`
    /// classification. Without this, the timeout branch could have been
    /// written to swallow every summary-less run.
    @Fact
    func GenuineBuildFailure_StillNamedABuildFailure() {
        let context = Issue3931KilledTestRunClassificationTests.Context()
        let outcome = TestParityStage().EvaluateMirroredTestRun(
            context,
            ProcessRunResult(1, BuildFailureOutput, string.Empty, false)
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Contains(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-BUILD-FAILED")
        Assert.DoesNotContain(outcome.Artifacts, (a TriageArtifact) -> a.Diagnostic!!.Id == "LIBRARY-TESTS-TIMED-OUT")
    }

    /// Issue #4045 gave `Compiler.Tests` a 90-minute budget by app id;
    /// issue #3501 replaced that hand-set exception with a size-derived one.
    /// The property #4045 bought must survive the replacement: the largest
    /// suite in the corpus still gets a budget it can COMPLETE in, and it is
    /// still bounded. Expressed against the sizing function rather than the app
    /// id, because there is no app id in the budget any more.
    @Fact
    func CompilerTestsSizedSuiteGetsACompleteButStillBoundedParityBudget() {
        // test/Compiler.Tests declares 4,103 [Fact] methods; its migrated
        // validation measured ~81 minutes in gate run 34232380469.
        let compilerTests = SdkCompileRunner.MirroredTestRunTimeoutFor(4103)
        // Issue #4633 raised the ceiling past 90 minutes, so the size formula
        // now decides; it must never fall below what #4045 granted by hand.
        Assert.True(
            compilerTests >= TimeSpan.FromMinutes(90),
            "Compiler.Tests' budget $compilerTests is below the 90 minutes #4045 granted."
        )
        Assert.True(compilerTests <= SdkCompileRunner.MirroredTestRunTimeoutCeiling)
        // And a suite of ordinary size keeps the tight budget, so a hang there
        // still fails promptly rather than waiting out the largest app's grant.
        Assert.Equal(TimeSpan.FromMinutes(10), SdkCompileRunner.MirroredTestRunTimeoutFor(12))
    }

    shared {
        /// The captured shape of a killed run: some `[FAIL]` lines, then
        /// ProcessRunner's kill notice — and no `Failed! … Total: N` anywhere.
        private const KilledRunOutput string = `[xUnit.net 00:00:05.01]     ChainedMemberAccess_ResolvesInnerSegment [FAIL]
[xUnit.net 00:02:50.09]     OpenChangeAndSave_PushMode_PublishFullBindingDiagnostics [FAIL]

[ProcessRunner] 'dotnet' timed out after 00:10:00 and was killed.`

        private const BuildFailureOutput string = "Determining projects to restore...\n/tmp/migrated/Own.Tests/Own.gs(3,1): error GS0157: Cannot find type Nope."

        private func Context() StageExecutionContext {
            let dir = Path.Combine(AppContext.BaseDirectory, "issue-3931-killed-run", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(dir)
            let csPath = Path.Combine(dir, "Own.cs")
            File.WriteAllText(csPath, "using Xunit; public class Own { [Fact] public void A() { } }")
            let projectPath = Path.Combine(dir, "Own.Tests.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>`)
            let app = CorpusApp("test/Own.Tests", projectPath, TargetKind.Library)
            let options = PipelineOptions{OutputRoot: dir}
            let triage = TriageBuilder("run_1", "2026-09-05T00:00:00Z", "0.0.0", app.Id)
            let context = StageExecutionContext(app, options, GscInvoker(FindCompiler()), dir, triage)
            context.EmittedFiles.Add(EmittedGsFile("Own.gs", "Own.gs", csPath, string.Empty))
            return context
        }

        private func FindCompiler() string {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return "gsc.dll"
        }
    }
}

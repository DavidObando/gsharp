// <copyright file="Issue1933UnsafeIlVerifyPolicyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Regression tests for issue #1933: stage 3 (ilverify) had no unsafe-IL
/// policy, so pointer writes, `fixed`, and `stackalloc` — which
/// produce IL that is unverifiable BY DESIGN (the csc-compiled baseline of the
/// same C# fails ilverify identically; this is not a gsc defect) — always
/// gated the pipeline. (cref:CorpusApp.AllowUnsafeIl) (discovered from
/// a sibling `ilverify.allow-unsafe` marker file, mirroring the always-on
/// (cref:IlVerifyRunner.KnownIlVerifyFalsePositives) ignore bundle but
/// opt-in per app) lets (cref:IlVerifyStage) treat such a failure as
/// expected rather than gating, while still gating a bare tool crash and
/// still gating any app that has not opted in.
@Collection("IlVerifyPipeline")
open class Issue1933UnsafeIlVerifyPolicyTests {
    /// An app with (cref:CorpusApp.AllowUnsafeIl) unset (the default)
    /// still gates on a real ilverify error — the opt-in changes nothing for
    /// apps that never asked for it.
    @Fact
    async func ExecuteAsync_UnsafeIlError_WithoutAllowUnsafeIl_StillFailsStage() {
        let outcome = await RunWithFakeResultAsync(allowUnsafeIl: false, FakeUnverifiablePointerResult())
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Single(outcome.Artifacts)
    }

    /// An app that opts in via (cref:CorpusApp.AllowUnsafeIl) passes
    /// stage 3 even though ilverify reported a real (parsed) error — the
    /// known-unverifiable-by-design unsafe IL is expected, not a gap.
    @Fact
    async func ExecuteAsync_UnsafeIlError_WithAllowUnsafeIl_PassesStage() {
        let outcome = await RunWithFakeResultAsync(allowUnsafeIl: true, FakeUnverifiablePointerResult())
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Empty(outcome.Artifacts)
    }

    /// The allow-unsafe policy does not paper over a broken verifier run: a
    /// non-zero exit with zero parseable error lines (a tool crash) still
    /// fails the stage even for an app that opted in, since that signals a
    /// crash, not the app's own unverifiable-by-design unsafe IL.
    @Fact
    async func ExecuteAsync_ToolCrash_WithAllowUnsafeIl_StillFailsStage() {
        let crash = IlVerifyResult.FromRun(134, "Segmentation fault (core dumped)", Array.Empty[IlVerifyError]())
        let outcome = await RunWithFakeResultAsync(allowUnsafeIl: true, crash)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Single(outcome.Artifacts)
    }

    /// (cref:CorpusDiscovery) sets (cref:CorpusApp.AllowUnsafeIl)
    /// from a sibling `ilverify.allow-unsafe` marker file, and the
    /// quarantined-no-more `corpus/grid/G12-Unsafe-Console` app carries it
    /// (re-enabling the pointer/fixed/stackalloc grid fixtures, issue #1933).
    @Fact
    func CorpusDiscovery_G12UnsafeConsole_HasAllowUnsafeIlSet() {
        let corpus string? = ResolveCorpusDir()
        let g12 = CorpusDiscovery.FindById(corpus, "corpus/G12-Unsafe-Console")!!
        Assert.NotNull(g12)
        Assert.True(
            g12.AllowUnsafeIl,
            "corpus/G12-Unsafe-Console must carry the ilverify.allow-unsafe marker (issue #1933)."
        )
    }

    /// Issue #1985: G05's marker scopes the allowance to just the
    /// stackalloc-emitting fixture — a future genuine unsafe-IL error
    /// elsewhere in G05 must not be swallowed by the app-wide marker.
    @Fact
    func CorpusDiscovery_G05CollectionsConsole_ScopesAllowUnsafeIlToStackAllocFixture() {
        let corpus string? = ResolveCorpusDir()
        let g05 = CorpusDiscovery.FindById(corpus, "corpus/G05-Collections-Console")!!
        Assert.NotNull(g05)
        Assert.True(g05.AllowUnsafeIl)
        Assert.Equal([]string{"Corpus.Grid05.StackAllocArrayCreationExpressionFixture"}, g05.AllowUnsafeIlTypes)
    }

    /// Issue #1985: an ilverify error whose failing method is NOT in the
    /// marker's allow-listed fixture types still gates the stage, even though
    /// the app carries the marker — the whole app is no longer a blanket
    /// allowance once the marker is scoped.
    @Fact
    async func ExecuteAsync_UnsafeIlError_OutsideAllowedFixtureType_StillFailsStage() {
        let error = IlVerifyError(
            "ExpectedNumericType",
            "Corpus.Grid05.SomeOtherFixture::Run()",
            "[IL]: Error [ExpectedNumericType]: [/abs/App.dll : Corpus.Grid05.SomeOtherFixture::Run()] boom"
        )
        let fakeResult = IlVerifyResult.FromRun(2, error.RawLine, []IlVerifyError{error})
        let outcome = await RunWithFakeResultAsync(
            allowUnsafeIl: true,
            fakeResult,
            allowUnsafeIlTypes: []string{"Corpus.Grid05.StackAllocArrayCreationExpressionFixture"}
        )
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Single(outcome.Artifacts)
    }

    /// Issue #1985: an ilverify error whose failing method IS in the marker's
    /// allow-listed fixture types passes, same as the whole-app allowance.
    @Fact
    async func ExecuteAsync_UnsafeIlError_InsideAllowedFixtureType_PassesStage() {
        let outcome = await RunWithFakeResultAsync(
            allowUnsafeIl: true,
            FakeUnverifiablePointerResult(),
            allowUnsafeIlTypes: []string{"Corpus.Grid12.Constructs.PointerTypeFixture"}
        )
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.Empty(outcome.Artifacts)
    }

    /// An app with no `ilverify.allow-unsafe` marker file (the common
    /// case) discovers (cref:CorpusApp.AllowUnsafeIl) as
    /// `false`.
    @Fact
    func CorpusDiscovery_AppWithoutMarker_HasAllowUnsafeIlFalse() {
        let corpus string? = ResolveCorpusDir()
        let l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console")!!
        Assert.NotNull(l1)
        Assert.False(l1.AllowUnsafeIl)
    }

    /// End-to-end (issue #1933 DoD): the re-enabled
    /// `corpus/grid/G12-Unsafe-Console` grid fixture migrates fully
    /// green — translate, compile, ilverify (via the allow-unsafe policy), and
    /// test-parity all pass. Gated on the compiler artifact and the
    /// `dotnet-ilverify` tool being present, like the other e2e tests.
    @Fact
    async func G12UnsafeConsole_MigratesGreen_EndToEnd() {
        let compiler string? = FindCompiler()
        if compiler == nil || !IlVerifyToolAvailable() {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("g12-unsafe-e2e")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options)
        let g12 = CorpusDiscovery.FindById(corpus, "corpus/G12-Unsafe-Console")!!
        Assert.NotNull(g12)
        Assert.True(g12.AllowUnsafeIl)
        let result = await pipeline.RunAsync([]CorpusApp{g12})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            "corpus/G12-Unsafe-Console must migrate green end-to-end under the ilverify " +
                "allow-unsafe policy (issue #1933). Failure category: " +
                (app.FailureCategory ?? "<none>") +
                "; artifacts: " +
                string.Join(", ", app.Artifacts)
        )
        Assert.Empty(app.Artifacts)
        Assert.All(app.Stages, (s StageResult) -> Assert.Equal("passed", s.Status))
    }

    private class FakeResultIlVerifyRunner : IlVerifyRunner {
        private let result IlVerifyResult

        init(result IlVerifyResult) {
            this.result = result
        }

        override func Verify(
            assemblyPath string,
            additionalReferences IReadOnlyList[string]? = nil
        ) IlVerifyResult -> this.result
    }

    shared {
        private func FakeUnverifiablePointerResult() IlVerifyResult {
            // Mirrors a real ilverify run against the csc-compiled baseline of
            // Constructs/PointerType.cs: `int* p = &x;` trips ExpectedNumericType.
            let error = IlVerifyError(
                "ExpectedNumericType",
                "Corpus.Grid12.Constructs.PointerTypeFixture::Run()",
                "[IL]: Error [ExpectedNumericType]: [/abs/App.dll : Corpus.Grid12.Constructs.PointerTypeFixture::Run()]" +
                    "[offset 0x00000004][found address of Int32] Expected numeric type on the stack."
            )
            return IlVerifyResult.FromRun(2, error.RawLine, []IlVerifyError{error})
        }

        private async func RunWithFakeResultAsync(
            allowUnsafeIl bool,
            fakeResult IlVerifyResult,
            allowUnsafeIlTypes IReadOnlyList[string]? = nil
        ) StageOutcome {
            let outRoot = NewOutputRoot("issue-1933-unsafe-il")
            let runner = FakeResultIlVerifyRunner(fakeResult)
            let stage = IlVerifyStage(runner)
            let fakeAssembly = Path.Combine(outRoot, "App.dll")
            File.WriteAllBytes(fakeAssembly, Array.Empty[uint8]())
            let app = CorpusApp(
                "corpus/Fake",
                "/fake/Fake.csproj",
                TargetKind.Exe,
                allowUnsafeIl: allowUnsafeIl,
                allowUnsafeIlTypes: allowUnsafeIlTypes
            )
            let options = PipelineOptions{GscPath: "/fake/gsc.dll", OutputRoot: outRoot}
            let context = StageExecutionContext(
                app,
                options,
                GscInvoker(options.GscPath!!),
                outRoot,
                TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Fake")
            ){EmittedAssemblyPath = fakeAssembly}
            return await stage.ExecuteAsync(context)
        }

        private func IlVerifyToolAvailable() bool {
            if !IlVerifyRunner.IsEnabled {
                return true
            }
            try {
                return IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
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
            return nil
        }

        private func ResolveCorpusDir() string? -> TestFixtureSource.Resolve("tools", "cs2gs", "corpus")
    }
}

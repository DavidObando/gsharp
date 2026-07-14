// <copyright file="Issue1933UnsafeIlVerifyPolicyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1933: stage 3 (ilverify) had no unsafe-IL
/// policy, so pointer writes, <c>fixed</c>, and <c>stackalloc</c> — which
/// produce IL that is unverifiable BY DESIGN (the csc-compiled baseline of the
/// same C# fails ilverify identically; this is not a gsc defect) — always
/// gated the pipeline. <see cref="CorpusApp.AllowUnsafeIl"/> (discovered from
/// a sibling <c>ilverify.allow-unsafe</c> marker file, mirroring the always-on
/// <see cref="IlVerifyRunner.KnownIlVerifyFalsePositives"/> ignore bundle but
/// opt-in per app) lets <see cref="IlVerifyStage"/> treat such a failure as
/// expected rather than gating, while still gating a bare tool crash and
/// still gating any app that has not opted in.
/// </summary>
[Collection(IlVerifyPipelineCollection.Name)]
public class Issue1933UnsafeIlVerifyPolicyTests
{
    /// <summary>
    /// An app with <see cref="CorpusApp.AllowUnsafeIl"/> unset (the default)
    /// still gates on a real ilverify error — the opt-in changes nothing for
    /// apps that never asked for it.
    /// </summary>
    [Fact]
    public async Task ExecuteAsync_UnsafeIlError_WithoutAllowUnsafeIl_StillFailsStage()
    {
        StageOutcome outcome = await RunWithFakeResultAsync(
            allowUnsafeIl: false,
            FakeUnverifiablePointerResult());

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Single(outcome.Artifacts);
    }

    /// <summary>
    /// An app that opts in via <see cref="CorpusApp.AllowUnsafeIl"/> passes
    /// stage 3 even though ilverify reported a real (parsed) error — the
    /// known-unverifiable-by-design unsafe IL is expected, not a gap.
    /// </summary>
    [Fact]
    public async Task ExecuteAsync_UnsafeIlError_WithAllowUnsafeIl_PassesStage()
    {
        StageOutcome outcome = await RunWithFakeResultAsync(
            allowUnsafeIl: true,
            FakeUnverifiablePointerResult());

        Assert.Equal(StageStatus.Passed, outcome.Status);
        Assert.Empty(outcome.Artifacts);
    }

    /// <summary>
    /// The allow-unsafe policy does not paper over a broken verifier run: a
    /// non-zero exit with zero parseable error lines (a tool crash) still
    /// fails the stage even for an app that opted in, since that signals a
    /// crash, not the app's own unverifiable-by-design unsafe IL.
    /// </summary>
    [Fact]
    public async Task ExecuteAsync_ToolCrash_WithAllowUnsafeIl_StillFailsStage()
    {
        IlVerifyResult crash = IlVerifyResult.FromRun(134, "Segmentation fault (core dumped)", Array.Empty<IlVerifyError>());

        StageOutcome outcome = await RunWithFakeResultAsync(allowUnsafeIl: true, crash);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Single(outcome.Artifacts);
    }

    /// <summary>
    /// <see cref="CorpusDiscovery"/> sets <see cref="CorpusApp.AllowUnsafeIl"/>
    /// from a sibling <c>ilverify.allow-unsafe</c> marker file, and the
    /// quarantined-no-more <c>corpus/grid/G12-Unsafe-Console</c> app carries it
    /// (re-enabling the pointer/fixed/stackalloc grid fixtures, issue #1933).
    /// </summary>
    [Fact]
    public void CorpusDiscovery_G12UnsafeConsole_HasAllowUnsafeIlSet()
    {
        string corpus = ResolveCorpusDir();
        CorpusApp g12 = CorpusDiscovery.FindById(corpus, "corpus/G12-Unsafe-Console");

        Assert.NotNull(g12);
        Assert.True(g12.AllowUnsafeIl, "corpus/G12-Unsafe-Console must carry the ilverify.allow-unsafe marker (issue #1933).");
    }

    /// <summary>
    /// Issue #1985: G05's marker scopes the allowance to just the
    /// stackalloc-emitting fixture — a future genuine unsafe-IL error
    /// elsewhere in G05 must not be swallowed by the app-wide marker.
    /// </summary>
    [Fact]
    public void CorpusDiscovery_G05CollectionsConsole_ScopesAllowUnsafeIlToStackAllocFixture()
    {
        string corpus = ResolveCorpusDir();
        CorpusApp g05 = CorpusDiscovery.FindById(corpus, "corpus/G05-Collections-Console");

        Assert.NotNull(g05);
        Assert.True(g05.AllowUnsafeIl);
        Assert.Equal(
            new[] { "Corpus.Grid05.StackAllocArrayCreationExpressionFixture" },
            g05.AllowUnsafeIlTypes);
    }

    /// <summary>
    /// Issue #1985: an ilverify error whose failing method is NOT in the
    /// marker's allow-listed fixture types still gates the stage, even though
    /// the app carries the marker — the whole app is no longer a blanket
    /// allowance once the marker is scoped.
    /// </summary>
    [Fact]
    public async Task ExecuteAsync_UnsafeIlError_OutsideAllowedFixtureType_StillFailsStage()
    {
        var error = new IlVerifyError(
            "ExpectedNumericType",
            "Corpus.Grid05.SomeOtherFixture::Run()",
            "[IL]: Error [ExpectedNumericType]: [/abs/App.dll : Corpus.Grid05.SomeOtherFixture::Run()] boom");
        IlVerifyResult fakeResult = IlVerifyResult.FromRun(1, error.RawLine, new[] { error });

        StageOutcome outcome = await RunWithFakeResultAsync(
            allowUnsafeIl: true,
            fakeResult,
            allowUnsafeIlTypes: new[] { "Corpus.Grid05.StackAllocArrayCreationExpressionFixture" });

        Assert.Equal(StageStatus.Failed, outcome.Status);
        Assert.Single(outcome.Artifacts);
    }

    /// <summary>
    /// Issue #1985: an ilverify error whose failing method IS in the marker's
    /// allow-listed fixture types passes, same as the whole-app allowance.
    /// </summary>
    [Fact]
    public async Task ExecuteAsync_UnsafeIlError_InsideAllowedFixtureType_PassesStage()
    {
        StageOutcome outcome = await RunWithFakeResultAsync(
            allowUnsafeIl: true,
            FakeUnverifiablePointerResult(),
            allowUnsafeIlTypes: new[] { "Corpus.Grid12.Constructs.PointerTypeFixture" });

        Assert.Equal(StageStatus.Passed, outcome.Status);
        Assert.Empty(outcome.Artifacts);
    }

    /// <summary>
    /// An app with no <c>ilverify.allow-unsafe</c> marker file (the common
    /// case) discovers <see cref="CorpusApp.AllowUnsafeIl"/> as
    /// <see langword="false"/>.
    /// </summary>
    [Fact]
    public void CorpusDiscovery_AppWithoutMarker_HasAllowUnsafeIlFalse()
    {
        string corpus = ResolveCorpusDir();
        CorpusApp l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console");

        Assert.NotNull(l1);
        Assert.False(l1.AllowUnsafeIl);
    }

    /// <summary>
    /// End-to-end (issue #1933 DoD): the re-enabled
    /// <c>corpus/grid/G12-Unsafe-Console</c> grid fixture migrates fully
    /// green — translate, compile, ilverify (via the allow-unsafe policy), and
    /// test-parity all pass. Gated on the compiler artifact and the
    /// <c>dotnet-ilverify</c> tool being present, like the other e2e tests.
    /// </summary>
    [Fact]
    public async Task G12UnsafeConsole_MigratesGreen_EndToEnd()
    {
        string compiler = FindCompiler();
        if (compiler is null || !IlVerifyToolAvailable())
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("g12-unsafe-e2e");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options);

        CorpusApp g12 = CorpusDiscovery.FindById(corpus, "corpus/G12-Unsafe-Console");
        Assert.NotNull(g12);
        Assert.True(g12.AllowUnsafeIl);

        RunResult result = await pipeline.RunAsync(new[] { g12 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(
            app.Succeeded,
            "corpus/G12-Unsafe-Console must migrate green end-to-end under the ilverify " +
                "allow-unsafe policy (issue #1933). Failure category: " +
                (app.FailureCategory ?? "<none>") + "; artifacts: " + string.Join(", ", app.Artifacts));
        Assert.Empty(app.Artifacts);
        Assert.All(app.Stages, s => Assert.Equal("passed", s.Status));
    }

    private static IlVerifyResult FakeUnverifiablePointerResult()
    {
        // Mirrors a real ilverify run against the csc-compiled baseline of
        // Constructs/PointerType.cs: `int* p = &x;` trips ExpectedNumericType.
        var error = new IlVerifyError(
            "ExpectedNumericType",
            "Corpus.Grid12.Constructs.PointerTypeFixture::Run()",
            "[IL]: Error [ExpectedNumericType]: [/abs/App.dll : Corpus.Grid12.Constructs.PointerTypeFixture::Run()]" +
                "[offset 0x00000004][found address of Int32] Expected numeric type on the stack.");
        return IlVerifyResult.FromRun(1, error.RawLine, new[] { error });
    }

    private static async Task<StageOutcome> RunWithFakeResultAsync(
        bool allowUnsafeIl, IlVerifyResult fakeResult, IReadOnlyList<string> allowUnsafeIlTypes = null)
    {
        string outRoot = NewOutputRoot("issue-1933-unsafe-il");
        var runner = new FakeResultIlVerifyRunner(fakeResult);
        var stage = new IlVerifyStage(runner);

        string fakeAssembly = Path.Combine(outRoot, "App.dll");
        File.WriteAllBytes(fakeAssembly, Array.Empty<byte>());

        var app = new CorpusApp(
            "corpus/Fake",
            "/fake/Fake.csproj",
            TargetKind.Exe,
            allowUnsafeIl: allowUnsafeIl,
            allowUnsafeIlTypes: allowUnsafeIlTypes);
        var options = new PipelineOptions { GscPath = "/fake/gsc.dll", OutputRoot = outRoot };
        var context = new StageExecutionContext(
            app,
            options,
            new GscInvoker(options.GscPath),
            outRoot,
            new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Fake"))
        {
            EmittedAssemblyPath = fakeAssembly,
        };

        return await stage.ExecuteAsync(context);
    }

    private sealed class FakeResultIlVerifyRunner : IlVerifyRunner
    {
        private readonly IlVerifyResult result;

        public FakeResultIlVerifyRunner(IlVerifyResult result)
        {
            this.result = result;
        }

        public override IlVerifyResult Verify(string assemblyPath, IReadOnlyList<string> additionalReferences = null) =>
            this.result;
    }

    private static bool IlVerifyToolAvailable()
    {
        if (!IlVerifyRunner.IsEnabled)
        {
            return true;
        }

        try
        {
            return new IlVerifyRunner().EnsureToolAvailable();
        }
        catch
        {
            return false;
        }
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate tools/cs2gs/corpus above " + AppContext.BaseDirectory);
    }
}

// <copyright file="Issue4767ReferencedDependencyValidityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Cli
import Cs2Gs.Pipeline
import Cs2Gs.Report
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Text.Json
import System.Threading.Tasks
import Xunit

/// Issue #4767: a selected consumer in `--no-via-sdk` diagnostic mode (or any
/// mode where a required referenced producer is invalid) must fail closed as
/// `dependency-blocked` without duplicating producer-owned `CS2GS-GAP` or
/// `compile-error` triage artifacts onto the consumer, and a missing required
/// output assembly must never pass `IlVerifyStage` or `TestParityStage`.
@Collection("IlVerifyPipeline")
open class Issue4767ReferencedDependencyValidityTests {
    /// Nine real CLI migrations covering Models-only, Consumer-only, and
    /// Models+Consumer selections across the two failing ref-property contracts
    /// (abstract ref getter and concrete override of ref getter) plus the
    /// supported ordinary non-ref control.
    @Fact
    async func CliMigrate_NoViaSdk_ProducerOwnershipAndConsumerDependencyBlocking_HoldAcrossAllNineRuns() {
        let compiler string? = FindCompiler()
        if compiler == nil || !IlVerifyToolAvailable() {
            return
        }
        for failingKind in[]string{"abstract-ref-getter", "concrete-override-ref-getter"} {
            let corpusRoot = WriteTwoProjectFixture(
                failingKind,
                if failingKind == "abstract-ref-getter" {
                    AbstractRefGetterModelsSource
                } else {
                    ConcreteOverrideRefGetterModelsSource
                }
            )
            try {
                let nativeModels = CompileNativeCSharp(
                    Path.Combine(corpusRoot, "native", "Models.dll"),
                    if failingKind == "abstract-ref-getter" {
                        AbstractRefGetterModelsSource
                    } else {
                        ConcreteOverrideRefGetterModelsSource
                    }
                )
                let nativeConsumer = CompileNativeCSharp(
                    Path.Combine(corpusRoot, "native", "Consumer.dll"),
                    ConsumerSource,
                    nativeModels
                )
                AssertPropertyGetterMetadata(nativeModels, expectByRef: true, expectAbstract: true)
                AssertConsumerReadMethodMetadata(nativeConsumer, nativeModels)

                // 1. Models-only: producer fails at translate with its own CS2GS-GAP at Models/Contracts.cs(5,5).
                let modelsRun = await RunCliMigrateAsync(compiler, corpusRoot, "models-only", "Models")
                Assert.Equal(1, modelsRun.ExitCode)
                Assert.False(modelsRun.Run.Succeeded)
                Assert.False(modelsRun.Summary.IsGreen)
                Assert.Equal(1, modelsRun.Summary.TotalApps)
                Assert.Equal(0, modelsRun.Summary.GreenApps)
                let modelsApp = Assert.Single(modelsRun.Run.Apps)
                Assert.Equal("corpus/Models", modelsApp.AppId)
                Assert.False(modelsApp.Succeeded)
                Assert.False(modelsApp.Unverified)
                Assert.Equal("translation-unsupported", modelsApp.FailureCategory)
                Assert.Equal("failed", modelsApp.Stages[0].Status)
                Assert.Equal(1, modelsApp.Stages[0].ArtifactCount)
                Assert.All(modelsApp.Stages.Skip(1), (s StageResult) -> Assert.Equal("skipped", s.Status))
                let modelsGap = Assert.Single(modelsRun.Summary.Gaps)
                Assert.Equal("CS2GS-GAP", modelsGap.Diagnostic.Id)
                let modelsOccurrence = Assert.Single(modelsGap.Occurrences)
                Assert.Equal("corpus/Models", modelsOccurrence.AppId)
                Assert.EndsWith("Contracts.cs", modelsOccurrence.SourceLocation.CsFile!!, StringComparison.Ordinal)
                Assert.Equal(5, modelsOccurrence.SourceLocation.CsLine)
                Assert.Equal(5, modelsOccurrence.SourceLocation.CsColumn)

                // 2. Consumer-only (producer unselected): consumer is dependency-blocked, 0 duplicate gaps, no DLL.
                let consumerRun = await RunCliMigrateAsync(compiler, corpusRoot, "consumer-only", "Consumer")
                Assert.Equal(1, consumerRun.ExitCode)
                Assert.False(consumerRun.Run.Succeeded)
                Assert.False(consumerRun.Summary.IsGreen)
                Assert.Equal(1, consumerRun.Summary.TotalApps)
                Assert.Equal(0, consumerRun.Summary.GreenApps)
                let consumerApp = Assert.Single(consumerRun.Run.Apps)
                Assert.Equal("corpus/Consumer", consumerApp.AppId)
                Assert.False(consumerApp.Succeeded)
                Assert.False(consumerApp.Unverified)
                Assert.Equal("dependency-blocked", consumerApp.FailureCategory)
                Assert.Empty(consumerApp.Artifacts)
                Assert.Empty(consumerApp.Fingerprints)
                Assert.Empty(consumerRun.Summary.Gaps)
                Assert.Equal("failed", consumerApp.Stages[0].Status)
                Assert.Equal(0, consumerApp.Stages[0].ArtifactCount)
                Assert.All(consumerApp.Stages.Skip(1), (s StageResult) -> Assert.Equal("skipped", s.Status))
                Assert.Empty(Directory.GetFiles(consumerRun.RunDir, "Consumer.dll", SearchOption.AllDirectories))

                // 3. Models + Consumer: denominator is 2, 0 green, producer owns the single gap, consumer is blocked.
                let bothRun = await RunCliMigrateAsync(compiler, corpusRoot, "both", "Models", "Consumer")
                Assert.Equal(1, bothRun.ExitCode)
                Assert.False(bothRun.Run.Succeeded)
                Assert.False(bothRun.Summary.IsGreen)
                Assert.Equal(2, bothRun.Summary.TotalApps)
                Assert.Equal(0, bothRun.Summary.GreenApps)
                let bothModels = bothRun.Run.Apps.Single((a AppResult) -> a.AppId == "corpus/Models")
                let bothConsumer = bothRun.Run.Apps.Single((a AppResult) -> a.AppId == "corpus/Consumer")
                Assert.False(bothModels.Succeeded)
                Assert.Equal("translation-unsupported", bothModels.FailureCategory)
                Assert.Single(bothModels.Artifacts)
                Assert.False(bothConsumer.Succeeded)
                Assert.False(bothConsumer.Unverified)
                Assert.Equal("dependency-blocked", bothConsumer.FailureCategory)
                Assert.Empty(bothConsumer.Artifacts)
                Assert.Empty(bothConsumer.Fingerprints)
                let sharedGap = Assert.Single(bothRun.Summary.Gaps)
                Assert.Equal("CS2GS-GAP", sharedGap.Diagnostic.Id)
                let gapOwner = Assert.Single(sharedGap.Occurrences)
                Assert.Equal("corpus/Models", gapOwner.AppId)
                Assert.Empty(Directory.GetFiles(bothRun.RunDir, "Consumer.dll", SearchOption.AllDirectories))
            } finally {
                Directory.Delete(corpusRoot, recursive: true)
            }
        }

        // Supported ordinary non-ref control: all 3 selections pass all 4 stages and metadata agrees.
        let controlRoot = WriteTwoProjectFixture("supported-control", SupportedNonRefModelsSource)
        try {
            let nativeControlModels = CompileNativeCSharp(
                Path.Combine(controlRoot, "native", "Models.dll"),
                SupportedNonRefModelsSource
            )
            let nativeControlConsumer = CompileNativeCSharp(
                Path.Combine(controlRoot, "native", "Consumer.dll"),
                ConsumerSource,
                nativeControlModels
            )
            AssertPropertyGetterMetadata(nativeControlModels, expectByRef: false, expectAbstract: true)
            AssertConsumerReadMethodMetadata(nativeControlConsumer, nativeControlModels)

            let controlModelsRun = await RunCliMigrateAsync(compiler, controlRoot, "control-models", "Models")
            Assert.Equal(0, controlModelsRun.ExitCode)
            Assert.True(controlModelsRun.Run.Succeeded)
            Assert.True(controlModelsRun.Summary.IsGreen)
            Assert.Equal(1, controlModelsRun.Summary.TotalApps)
            Assert.Equal(1, controlModelsRun.Summary.GreenApps)
            Assert.Empty(controlModelsRun.Summary.Gaps)

            let controlConsumerRun = await RunCliMigrateAsync(compiler, controlRoot, "control-consumer", "Consumer")
            Assert.Equal(0, controlConsumerRun.ExitCode)
            Assert.True(controlConsumerRun.Run.Succeeded)
            Assert.True(controlConsumerRun.Summary.IsGreen)
            Assert.Equal(1, controlConsumerRun.Summary.TotalApps)
            Assert.Equal(1, controlConsumerRun.Summary.GreenApps)
            Assert.Empty(controlConsumerRun.Summary.Gaps)
            let consumerApp = Assert.Single(controlConsumerRun.Run.Apps)
            Assert.All(consumerApp.Stages, (s StageResult) -> Assert.Equal("passed", s.Status))
            let emittedConsumerDll = Assert.Single(
                Directory.GetFiles(controlConsumerRun.RunDir, "Consumer.dll", SearchOption.AllDirectories)
            )
            AssertPropertyGetterMetadata(emittedConsumerDll, expectByRef: false, expectAbstract: true)
            AssertConsumerReadMethodMetadata(emittedConsumerDll)

            let controlBothRun = await RunCliMigrateAsync(compiler, controlRoot, "control-both", "Models", "Consumer")
            Assert.Equal(0, controlBothRun.ExitCode)
            Assert.True(controlBothRun.Run.Succeeded)
            Assert.True(controlBothRun.Summary.IsGreen)
            Assert.Equal(2, controlBothRun.Summary.TotalApps)
            Assert.Equal(2, controlBothRun.Summary.GreenApps)
            Assert.Empty(controlBothRun.Summary.Gaps)
        } finally {
            Directory.Delete(controlRoot, recursive: true)
        }
    }

    /// When a required referenced producer passes stage 1 (translate) with zero
    /// Unsupported diagnostics and fails in stage 2 (compile) on a referenced
    /// source file, the consumer must fail stage 2 as `dependency-blocked`
    /// without duplicating the producer's compile-error artifact or passing
    /// stage 3 with no emitted assembly.
    @Fact
    async func CliMigrate_NoViaSdk_CompileStageReferencedFailure_BlocksConsumerWithoutDuplicateArtifacts() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpusRoot = WriteTwoProjectFixture("compile-stage-producer-failure", CompileFailingModelsSource)
        try {
            let modelsRun = await RunCliMigrateAsync(compiler, corpusRoot, "compile-models", "Models")
            Assert.Equal(1, modelsRun.ExitCode)
            let modelsApp = Assert.Single(modelsRun.Run.Apps)
            Assert.False(modelsApp.Succeeded)
            Assert.Equal("compile-error", modelsApp.FailureCategory)
            Assert.Equal("passed", modelsApp.Stages[0].Status)
            Assert.Equal("failed", modelsApp.Stages[1].Status)
            Assert.Single(modelsApp.Artifacts)

            let consumerRun = await RunCliMigrateAsync(compiler, corpusRoot, "compile-consumer", "Consumer")
            Assert.Equal(1, consumerRun.ExitCode)
            Assert.False(consumerRun.Run.Succeeded)
            Assert.False(consumerRun.Summary.IsGreen)
            let consumerApp = Assert.Single(consumerRun.Run.Apps)
            Assert.False(consumerApp.Succeeded)
            Assert.False(consumerApp.Unverified)
            Assert.Equal("dependency-blocked", consumerApp.FailureCategory)
            Assert.Empty(consumerApp.Artifacts)
            Assert.Empty(consumerApp.Fingerprints)
            Assert.Empty(consumerRun.Summary.Gaps)
            Assert.Equal("passed", consumerApp.Stages[0].Status)
            Assert.Equal("failed", consumerApp.Stages[1].Status)
            Assert.Equal(0, consumerApp.Stages[1].ArtifactCount)
            Assert.Equal("skipped", consumerApp.Stages[2].Status)
            Assert.Equal("skipped", consumerApp.Stages[3].Status)
            Assert.Empty(Directory.GetFiles(consumerRun.RunDir, "Consumer.dll", SearchOption.AllDirectories))

            let bothRun = await RunCliMigrateAsync(compiler, corpusRoot, "compile-both", "Models", "Consumer")
            Assert.Equal(1, bothRun.ExitCode)
            Assert.Equal(2, bothRun.Summary.TotalApps)
            Assert.Equal(0, bothRun.Summary.GreenApps)
            let singleGap = Assert.Single(bothRun.Summary.Gaps)
            Assert.Equal("corpus/Models", Assert.Single(singleGap.Occurrences).AppId)
        } finally {
            Directory.Delete(corpusRoot, recursive: true)
        }
    }

    /// Missing required output assembly must never become a passed verification
    /// stage in `IlVerifyStage` or `TestParityStage`.
    @Fact
    async func VerificationStages_MissingEmittedAssembly_FailClosed() {
        let outRoot = NewDirectory("missing-assembly")
        try {
            let goldenPath = Path.Combine(outRoot, "baseline.stdout.golden")
            File.WriteAllText(goldenPath, "expected\n")
            let app = CorpusApp("corpus/Missing", Path.Combine(outRoot, "Missing.csproj"), TargetKind.Exe, goldenPath)
            let options = PipelineOptions{GscPath: "/fake/gsc.dll", OutputRoot: outRoot}
            let context = StageExecutionContext(
                app,
                options,
                GscInvoker(options.GscPath!!),
                outRoot,
                TriageBuilder("run_1", "2026-10-05T00:00:00Z", "0.5.0", app.Id)
            )
            context.EmittedFiles.Add(
                EmittedGsFile(
                    Path.Combine(outRoot, "Program.gs"),
                    "corpus_Missing/Program.gs",
                    Path.Combine(outRoot, "Program.cs"),
                    "func main() {}\n"
                )
            )
            let ilverifyOutcome = await IlVerifyStage().ExecuteAsync(context)
            Assert.Equal(StageStatus.Failed, ilverifyOutcome.Status)
            let ilverifyArtifact = Assert.Single(ilverifyOutcome.Artifacts)
            Assert.Equal("IlVerifyMissingAssembly", ilverifyArtifact.Diagnostic!!.Id)

            let parityOutcome = await TestParityStage().ExecuteAsync(context)
            Assert.Equal(StageStatus.Failed, parityOutcome.Status)
            let parityArtifact = Assert.Single(parityOutcome.Artifacts)
            Assert.Equal("STDOUT-MISMATCH", parityArtifact.Diagnostic!!.Id)
        } finally {
            Directory.Delete(outRoot, recursive: true)
        }
    }

    /// Review finding 1 (`PRRT_kwDOCzQNb86zvJa3`): a declared `ProjectReference`
    /// disabled by an `ItemGroup` or item `Condition` must stay in
    /// `context.ProjectReferences` for project emission, but must not mark the
    /// consumer `dependency-blocked` when the inactive target fails.
    @Fact
    async func InactiveConditionedProjectReference_ToFailedProducer_DoesNotBlockConsumer() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpusRoot = WriteTwoProjectFixture("inactive-condition", AbstractRefGetterModelsSource)
        try {
            let modelsProject = Path.Combine(corpusRoot, "Models", "Models.csproj")
            let consumerProject = Path.Combine(corpusRoot, "Consumer", "Consumer.csproj")
            File.WriteAllText(
                consumerProject,
                "<Project Sdk=\"Microsoft.NET.Sdk\">\n" +
                    "  <PropertyGroup>\n" +
                    "    <TargetFramework>net10.0</TargetFramework>\n" +
                    "    <Nullable>enable</Nullable>\n" +
                    "  </PropertyGroup>\n" +
                    "  <ItemGroup Condition=\"'$$(Configuration)' == 'Never'\">\n" +
                    "    <ProjectReference Include=\"../Models/Models.csproj\" />\n" +
                    "  </ItemGroup>\n" +
                    "</Project>\n"
            )
            File.WriteAllText(Path.Combine(corpusRoot, "Consumer", "Consumer.cs"), `namespace Consumers;

public static class Consumer
{
    public static int Read(int value) => value + 1;
}
`)
            let outRoot = Path.Combine(corpusRoot, "runs")
            let invalidProjects = HashSet[string](StringComparer.OrdinalIgnoreCase){Path.GetFullPath(modelsProject)}
            let options = PipelineOptions{
                GscPath: compiler,
                OutputRoot: outRoot,
                SourceRoot: corpusRoot,
                InvalidTranslatedProjectPaths: invalidProjects,
                InvalidCompiledProjectPaths: invalidProjects
            }
            let app = CorpusApp("corpus/Consumer", consumerProject, TargetKind.Library)
            let context = StageExecutionContext(
                app,
                options,
                GscInvoker(compiler),
                outRoot,
                TriageBuilder("run_inactive", "2026-10-05T00:00:00Z", "0.5.0", app.Id)
            )
            let translateOutcome = await TranslateStage().ExecuteAsync(context)
            Assert.Equal(StageStatus.Passed, translateOutcome.Status)
            Assert.Single(context.ProjectReferences)
            Assert.True(context.EvaluatedProjectReferencesResolved)
            Assert.Empty(context.EvaluatedProjectReferencePaths)
            Assert.False(CompileStage.HasInvalidProjectReference(context))
            let modelsDiagnostic = GscDiagnostic(
                "GS0185",
                "override mismatch",
                "error",
                Path.Combine(corpusRoot, "Models", "Contracts.gs"),
                5,
                5
            )
            Assert.False(CompileStage.IsReferencedProjectDiagnostic(context, modelsDiagnostic))

            // Positive control: once the reference is active in the evaluated graph,
            // CompileStage marks the consumer dependency-blocked.
            context.EvaluatedProjectReferencePaths.Add(Path.GetFullPath(modelsProject))
            Assert.True(CompileStage.HasInvalidProjectReference(context))
            Assert.True(CompileStage.IsReferencedProjectDiagnostic(context, modelsDiagnostic))
            let blockedCompileOutcome = await CompileStage().ExecuteAsync(context)
            Assert.Equal(StageStatus.Failed, blockedCompileOutcome.Status)
            Assert.Equal("dependency-blocked", blockedCompileOutcome.FailureCategory)
            Assert.Empty(blockedCompileOutcome.Artifacts)
        } finally {
            Directory.Delete(corpusRoot, recursive: true)
        }
    }

    /// Review finding 2 (`PRRT_kwDOCzQNb86zvJbf`): in `--no-via-sdk` runs, a
    /// workspace-load failure (`CS2GS0001`) in a referenced producer must remain
    /// producer-owned and mark the selected consumer `dependency-blocked` with
    /// zero consumer-owned triage artifacts.
    @Fact
    async func CliMigrate_NoViaSdk_ReferencedProducerWorkspaceLoadFailure_BlocksConsumerWithoutConsumerArtifact() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpusRoot = WriteTwoProjectFixture("referenced-load-failure", SupportedNonRefModelsSource)
        try {
            File.WriteAllText(Path.Combine(corpusRoot, "Models", "Models.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../DoesNotExist/DoesNotExist.csproj" />
  </ItemGroup>
</Project>
`)
            let modelsRun = await RunCliMigrateAsync(compiler, corpusRoot, "load-models", "Models")
            Assert.Equal(1, modelsRun.ExitCode)
            let modelsApp = Assert.Single(modelsRun.Run.Apps)
            Assert.False(modelsApp.Succeeded)
            Assert.Equal("translation-unsupported", modelsApp.FailureCategory)
            Assert.Single(modelsApp.Artifacts)
            let modelsGap = Assert.Single(modelsRun.Summary.Gaps)
            Assert.Equal("CS2GS0001", modelsGap.Diagnostic.Id)
            Assert.Equal("corpus/Models", Assert.Single(modelsGap.Occurrences).AppId)

            let consumerRun = await RunCliMigrateAsync(compiler, corpusRoot, "load-consumer", "Consumer")
            Assert.Equal(1, consumerRun.ExitCode)
            Assert.False(consumerRun.Run.Succeeded)
            Assert.False(consumerRun.Summary.IsGreen)
            let consumerApp = Assert.Single(consumerRun.Run.Apps)
            Assert.False(consumerApp.Succeeded)
            Assert.False(consumerApp.Unverified)
            Assert.Equal("dependency-blocked", consumerApp.FailureCategory)
            Assert.Empty(consumerApp.Artifacts)
            Assert.Empty(consumerApp.Fingerprints)
            Assert.Empty(consumerRun.Summary.Gaps)
            let translateLog = File.ReadAllText(
                Assert.Single(Directory.GetFiles(consumerRun.RunDir, "translate.log", SearchOption.AllDirectories))
            )
            Assert.Contains("dependency-blocked: referenced project", translateLog, StringComparison.Ordinal)
            Assert.Contains("failed workspace load", translateLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(corpusRoot, recursive: true)
        }
    }

    /// Review finding 3 (`PRRT_kwDOCzQNb86zvJb5`): an unselected SDK-mode
    /// referenced producer with valid C# source and a malformed `.resx` file
    /// must fail validation in `IsUnselectedReferencedProjectValid` and mark the
    /// consumer `dependency-blocked` without consumer-owned artifacts.
    @Fact
    async func TranslateStage_ViaSdk_UnselectedProducerWithMalformedResx_BlocksConsumerWithoutConsumerArtifact() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpusRoot = WriteTwoProjectFixture("unselected-malformed-resx", SupportedNonRefModelsSource)
        try {
            let modelsResxPath = Path.Combine(corpusRoot, "Models", "Resources.resx")
            File.WriteAllText(modelsResxPath, "<root><broken")
            let outRoot = Path.Combine(corpusRoot, "runs")
            let consumerProject = Path.Combine(corpusRoot, "Consumer", "Consumer.csproj")
            let options = PipelineOptions{
                GscPath: compiler,
                OutputRoot: outRoot,
                SourceRoot: corpusRoot,
                CompileViaSdk: true,
                ValidatedReferencedProjects: Dictionary[string, bool](StringComparer.OrdinalIgnoreCase)
            }
            let app = CorpusApp("corpus/Consumer", consumerProject, TargetKind.Library)
            let context = StageExecutionContext(
                app,
                options,
                GscInvoker(compiler),
                outRoot,
                TriageBuilder("run_resx", "2026-10-05T00:00:00Z", "0.5.0", app.Id)
            )
            let outcome = await TranslateStage().ExecuteAsync(context)
            Assert.Equal(StageStatus.Failed, outcome.Status)
            Assert.Equal("dependency-blocked", outcome.FailureCategory)
            Assert.Empty(outcome.Artifacts)
            let modelsProjectPath = Path.GetFullPath(Path.Combine(corpusRoot, "Models", "Models.csproj"))
            Assert.True(options.ValidatedReferencedProjects!!.TryGetValue(modelsProjectPath, out var cachedValid))
            Assert.False(cachedValid)
        } finally {
            Directory.Delete(corpusRoot, recursive: true)
        }
    }

    private data class CliRunOutcome(ExitCode int32, RunDir string, Run RunResult, Summary ReportModel) : IEquatable[
        Issue4767ReferencedDependencyValidityTests.CliRunOutcome
    ] { }

    shared {
        private const AbstractRefGetterModelsSource string = `namespace Contracts;

public abstract class R
{
    public abstract ref int Value { get; }
}
`

        private const ConcreteOverrideRefGetterModelsSource string = `namespace Contracts;

public abstract class R
{
    public abstract ref int Value { get; }
}
public sealed class Impl : R
{
    private int backing;
    public override ref int Value => ref backing;
}
`

        private const SupportedNonRefModelsSource string = `namespace Contracts;

public abstract class R
{
    public abstract int Value { get; }
}
public sealed class Impl : R
{
    public override int Value => 42;
}
`

        private const CompileFailingModelsSource string = `namespace Contracts;

public abstract class R
{
    public int Value => MissingProducerHelper();
}
`

        private const ConsumerSource string = `namespace Consumers;

public static class Consumer
{
    public static int Read(Contracts.R value) => value.Value;
}
`

        private async func RunCliMigrateAsync(
            compiler string,
            corpusRoot string,
            label string,
            appIds ...string
        ) Issue4767ReferencedDependencyValidityTests
            .CliRunOutcome {
            let outRoot = Path.Combine(corpusRoot, "runs-" + label)
            let args = List[string]{
                "migrate",
                "--diagnostic-run",
                "--corpus",
                corpusRoot,
                "--no-via-sdk",
                "--out",
                outRoot,
                "--gsc",
                compiler
            }
            for appId in appIds {
                args.Add("--app")
                args.Add(appId)
            }
            let exitCode = await Program.Main(args.ToArray()).ConfigureAwait(false)
            let runJsonPath = Assert.Single(Directory.GetFiles(outRoot, "run.json", SearchOption.AllDirectories))
            let runDir = Path.GetDirectoryName(runJsonPath)!!
            let run = JsonSerializer.Deserialize[RunResult](File.ReadAllText(runJsonPath), TriageSerialization.Options)
            let summary = JsonSerializer.Deserialize[ReportModel](
                File.ReadAllText(Path.Combine(runDir, "summary.json")),
                TriageSerialization.Options
            )
            Assert.NotNull(run)
            Assert.NotNull(summary)
            return Issue4767ReferencedDependencyValidityTests.CliRunOutcome(exitCode, runDir, run, summary)
        }

        private func WriteTwoProjectFixture(label string, modelsSource string) string {
            let root = NewDirectory(label)
            File.WriteAllText(Path.Combine(root, "Directory.Build.props"), "<Project></Project>")
            let modelsDir = Path.Combine(root, "Models")
            let consumerDir = Path.Combine(root, "Consumer")
            Directory.CreateDirectory(modelsDir)
            Directory.CreateDirectory(consumerDir)
            File.WriteAllText(Path.Combine(modelsDir, "Models.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`)
            File.WriteAllText(Path.Combine(modelsDir, "Contracts.cs"), modelsSource)
            File.WriteAllText(Path.Combine(consumerDir, "Consumer.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Models/Models.csproj" />
  </ItemGroup>
</Project>
`)
            File.WriteAllText(Path.Combine(consumerDir, "Consumer.cs"), ConsumerSource)
            return root
        }

        private func CompileNativeCSharp(outputPath string, source string, referencePath string? = nil) string {
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!!)
            var references IEnumerable[MetadataReference] = CSharpProjectLoader.RuntimeReferences()
            if referencePath != nil {
                references = references.Append(MetadataReference.CreateFromFile(referencePath)).ToArray()
            }
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(outputPath),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(outputPath)
            let emit = compilation.Emit(stream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return outputPath
        }

        private func AssertPropertyGetterMetadata(assemblyPath string, expectByRef bool, expectAbstract bool) {
            let loadContext = AssemblyLoadContext("issue4767-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                using let stream = MemoryStream(File.ReadAllBytes(assemblyPath))
                let assembly = loadContext.LoadFromStream(stream)
                let contractType = assembly.GetType("Contracts.R")
                Assert.NotNull(contractType)
                let getter = contractType!!.GetProperty("Value")?.GetMethod
                Assert.NotNull(getter)
                Assert.Equal(expectByRef, getter!!.ReturnType.IsByRef)
                Assert.Equal(expectAbstract, getter!!.IsAbstract)
            } finally {
                loadContext.Unload()
            }
        }

        private func AssertConsumerReadMethodMetadata(assemblyPath string, referencePath string? = nil) {
            let loadContext = AssemblyLoadContext("issue4767-read-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                if referencePath != nil {
                    using let refStream = MemoryStream(File.ReadAllBytes(referencePath))
                    loadContext.LoadFromStream(refStream)
                }
                using let stream = MemoryStream(File.ReadAllBytes(assemblyPath))
                let assembly = loadContext.LoadFromStream(stream)
                let consumerType = assembly.GetType("Consumers.Consumer")
                Assert.NotNull(consumerType)
                let readMethod = consumerType!!.GetMethod("Read", BindingFlags.Public | BindingFlags.Static)
                Assert.NotNull(readMethod)
                Assert.Equal(typeof(int32), readMethod!!.ReturnType)
            } finally {
                loadContext.Unload()
            }
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

        private func NewDirectory(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "issue4767-tests", label, Guid.NewGuid().ToString("N"))
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
    }
}

// <copyright file="MigrationPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import System.Text.Json
import System.Threading.Tasks
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Xunit
import System.Threading
import System.Xml.Linq

/// Tests for the stage-1/stage-2 migration pipeline (ADR-0115 §C/§D): the
/// fingerprint/dedup contract (§D.2), the triage artifact schema (§D.1), the L1
/// happy path through stage 2, captured failures, and `retryHistory`.
open class MigrationPipelineTests {
    @Fact
    func GeneratedProjectMap_PreservesPassthroughProjectsDuringValidation() {
        let sourceRoot = Path.Combine(Path.GetTempPath(), "source-" + Guid.NewGuid().ToString("N"))
        let destinationRoot = Path.Combine(Path.GetTempPath(), "migrated-" + Guid.NewGuid().ToString("N"))
        let appProject = Path.Combine(sourceRoot, "src", "App", "App.csproj")
        let runtimeProject = Path.Combine(sourceRoot, "src", "Runtime", "Runtime.csproj")
        let app = CorpusApp(
            "src/App/App.csproj",
            appProject,
            TargetKind.Library,
            relativeProjectPath: "src/App/App.csproj"
        )
        let paths = MigrationPipeline.BuildGeneratedProjectPaths(
            []CorpusApp{app},
            []string{runtimeProject},
            sourceRoot,
            destinationRoot,
            runDir: Path.Combine(destinationRoot, "runs"),
            repositoryLayout: true
        )
        Assert.Equal(Path.Combine(destinationRoot, "src", "App", "App.gsproj"), paths[Path.GetFullPath(appProject)])
        Assert.Equal(
            Path.Combine(destinationRoot, "src", "Runtime", "Runtime.csproj"),
            paths[Path.GetFullPath(runtimeProject)]
        )
    }

    /// The dedup fingerprint (§D.2) is identical for the same
    /// category/stage/diagnostic/construct-skeleton even when identifiers,
    /// literals, and positions differ, and differs when the diagnostic id
    /// changes — and is always rendered with the `sha256:` prefix.
    @Fact
    func Fingerprint_DedupsAcrossNamesAndPositions_ButSplitsOnDiagnosticId() {
        let a = Fingerprint.Compute(
            "compile-error",
            "compile",
            "GS0100",
            "GSharpConstruct",
            "let total int32 = sum(items, 3)"
        )
        let b = Fingerprint.Compute(
            "compile-error",
            "compile",
            "GS0100",
            "GSharpConstruct",
            "let amount int32 = add(values, 42)"
        )
        Assert.Equal(a, b)
        Assert.StartsWith("sha256:", a, StringComparison.Ordinal)
        let differentId = Fingerprint.Compute(
            "compile-error",
            "compile",
            "GS0313",
            "GSharpConstruct",
            "let total int32 = sum(items, 3)"
        )
        Assert.NotEqual(a, differentId)
        let differentKind = Fingerprint.Compute(
            "compile-error",
            "compile",
            "GS0100",
            "FuncConstruct",
            "let total int32 = sum(items, 3)"
        )
        Assert.NotEqual(a, differentKind)
    }

    /// The normalizer reduces a snippet to its identifier/literal-erased
    /// skeleton, preserving punctuation structure.
    @Fact
    func NormalizeShape_StripsIdentifiersAndLiterals_ToSkeleton() {
        let shape = Fingerprint.NormalizeShape("foo.Bar(\"hi\", 42, baz)")
        Assert.Equal("id.id(lit, lit, id)", shape)
        Assert.Equal(shape, Fingerprint.NormalizeShape("qux.Zap('x', 7, other)"))
    }

    /// A stage-2 `compile-error` artifact carries every §D.1 field, the
    /// `sha256:` fingerprint, and labels `Oats` + `bug`.
    @Fact
    func CompileErrorArtifact_HasFullSchema_AndBugLabel() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let emitted = EmittedGsFile("/abs/Sample.gs", "corpus_Sample/Sample.gs", "/abs/Sample.cs", `func F() {
    let x = g(1)
}
`)
        let diagnostic = GscDiagnostic("GS0100", "no overload for 'g'", "error", "Sample.gs", 2, 13)
        let artifact = builder.CompileError(diagnostic, emitted)
        let json = JsonSerializer.Serialize(artifact, TriageSerialization.Options)
        using let doc = JsonDocument.Parse(json)
        let root = doc.RootElement
        for field in[]string{
            "schemaVersion",
            "runId",
            "timestamp",
            "gscVersion",
            "corpusAppId",
            "stage",
            "category",
            "diagnostic",
            "sourceLocation",
            "offendingCSharpConstruct",
            "suggestedIssue",
            "fingerprint",
            "retryHistory"
        } {
            Assert.True(root.TryGetProperty(field, out _), "missing field '$field'")
        }
        Assert.Equal("1.0", root.GetProperty("schemaVersion").GetString())
        Assert.Equal("compile", root.GetProperty("stage").GetString())
        Assert.Equal("compile-error", root.GetProperty("category").GetString())
        Assert.Equal("GS0100", root.GetProperty("diagnostic").GetProperty("id").GetString())
        Assert.Equal(2, root.GetProperty("sourceLocation").GetProperty("gsLine").GetInt32())
        Assert.True(root.GetProperty("sourceLocation").GetProperty("csFile").ValueKind == JsonValueKind.Null)
        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal)
        let labels = root
            .GetProperty("suggestedIssue")
            .GetProperty("labels")
            .EnumerateArray()
            .Select((e JsonElement) -> e.GetString()!!)
            .ToArray()
        Assert.Contains("Oats", labels)
        Assert.Contains("bug", labels)
    }

    /// A stage-1 `translation-unsupported` artifact labels with `Oats`
    /// only (no `bug`) and maps the C# location, leaving the G# side null.
    @Fact
    func TranslationUnsupportedArtifact_HasOatsOnly_AndNullGsLocation() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let diagnostic = TranslationDiagnostic(
            "CastExpression",
            "casts have no canonical G# form yet",
            nil,
            TranslationSeverity.Unsupported
        )
        let artifact = builder.TranslationUnsupported(diagnostic)
        Assert.Equal("translation-unsupported", artifact.Category)
        Assert.Equal("translate", artifact.Stage)
        Assert.False(string.IsNullOrEmpty(artifact.Diagnostic!!.Id))
        Assert.Null(artifact.SourceLocation.GsFile)
        Assert.Null(artifact.SourceLocation.GsLine)
        Assert.Contains("Oats", artifact.SuggestedIssue!!.Labels)
        Assert.DoesNotContain("bug", artifact.SuggestedIssue!!.Labels)
        Assert.StartsWith("sha256:", artifact.Fingerprint, StringComparison.Ordinal)
    }

    /// Running the pipeline over `corpus/L1-Console` yields stage 1 and
    /// stage 2 GREEN with zero artifacts. Gated on the compiler artifact being
    /// present (it is when `GSharp.sln` is built), like the e2e test.
    @Fact
    async func L1_StagesOneAndTwo_AreGreen_WithZeroArtifacts() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("l1-green")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        // Pin to stages 1–2 so this test stays focused on the compile gate
        // regardless of the default stage list (which now also runs ilverify).
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console")!!
        Assert.NotNull(l1)
        let result = await pipeline.RunAsync([]CorpusApp{l1})
        let app = Assert.Single(result.Apps)
        Assert.True(app.Succeeded, "L1 must migrate green through stage 2.")
        Assert.Empty(app.Artifacts)
        Assert.All(app.Stages, (s StageResult) -> Assert.Equal("passed", s.Status))
        Assert.Equal(2, app.Stages.Count)
    }

    /// Issue #973 regression guard: pointing the pipeline at
    /// `corpus/L2-Library` (a `class Rectangle` holding a
    /// `Dimensions` value-type field) now migrates GREEN through the
    /// compile stage. This previously failed with the emit ICE
    /// `GS9998: Struct 'S' has no emitted TypeDef.` Gated on compiler
    /// presence (the pipeline resolves `gsc` up front).
    @Fact
    async func L2_StagesOneAndTwo_AreGreen_WithZeroArtifacts() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("l2-green")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        // Pin to stages 1–2 so this test stays focused on the compile gate
        // regardless of the default stage list (which also runs ilverify).
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let l2 = CorpusDiscovery.FindById(corpus, "corpus/L2-Library")!!
        Assert.NotNull(l2)
        let result = await pipeline.RunAsync([]CorpusApp{l2})
        let app = Assert.Single(result.Apps)
        Assert.True(app.Succeeded, "L2 must migrate green through stage 2 (issue #973).")
        Assert.Empty(app.Artifacts)
        Assert.All(app.Stages, (s StageResult) -> Assert.Equal("passed", s.Status))
        Assert.Equal(2, app.Stages.Count)
    }

    /// Diagnostic-run projects disable SDK AssemblyInfo generation, so the
    /// translator must retain only generated friend declarations while the
    /// hand-authored fully-qualified attribute stays in its translated source.
    @Fact
    async func L2_DiagnosticCompile_EmitsInternalsVisibleToExactlyOnce() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        if GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewOutputRoot("l2-friend-source")
        let l2 = CreateFriendAssemblyFixture(corpus, sourceRoot)
        let outRoot = NewOutputRoot("l2-friend-diagnostic")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{l2})
        let app = Assert.Single(result.Apps)
        Assert.True(app.Succeeded, string.Join(Environment.NewLine, app.Artifacts))
        let appDir = Path.Combine(outRoot, result.RunId, MigrationPipeline.SanitizeAppId(l2.Id))
        Assert.Equal(
            "@assembly:InternalsVisibleTo(\"L2-Library.Tests\")" + Environment.NewLine,
            File.ReadAllText(Path.Combine(appDir, "AssemblyInfo.gs"))
        )
        Assert.Contains(
            "@assembly: System.Runtime.CompilerServices.InternalsVisibleTo(\"L2-Library.Source.Tests\")",
            File.ReadAllText(Path.Combine(appDir, "FriendAssembly.gs")),
            StringComparison.Ordinal
        )
        let assemblyPath = Path.Combine(appDir, "bin", "Release", "net10.0", "L2-Library.dll")
        AssertFriendAssemblies(assemblyPath)
    }

    /// Repository projects preserve the MSBuild item and must not receive a
    /// second generated G# annotation from translation.
    @Fact
    async func L2_RepositoryCompile_EmitsInternalsVisibleToExactlyOnce() {
        let compiler string? = FindCompiler()
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        let sdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot)
        if compiler == nil || sdk == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let sourceRoot = NewOutputRoot("l2-friend-repository-source")
        let l2 = CreateFriendAssemblyFixture(corpus, sourceRoot)
        let destinationRoot = NewOutputRoot("l2-friend-repository")
        let projectDir = Path.Combine(destinationRoot, "L2-Library")
        Directory.CreateDirectory(projectDir)
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: sourceRoot,
            OutputRoot: destinationRoot,
            OutputLayout: MigrationOutputLayout.Repository
        }
        let context = StageExecutionContext(
            l2,
            options,
            GscInvoker(compiler),
            projectDir,
            TriageBuilder("run", "2026-07-28T00:00:00Z", "test", l2.Id)
        )
        let translation = await TranslateStage().ExecuteAsync(context)
        Assert.Equal(StageStatus.Passed, translation.Status)
        Assert.False(File.Exists(Path.Combine(projectDir, "AssemblyInfo.gs")))
        Assert.Contains(
            "@assembly: System.Runtime.CompilerServices.InternalsVisibleTo(\"L2-Library.Source.Tests\")",
            File.ReadAllText(Path.Combine(projectDir, "FriendAssembly.gs")),
            StringComparison.Ordinal
        )
        let generatedProjectPath = Path.Combine(projectDir, "L2-Library.gsproj")
        GSharpProjectTransformer.Transform(
            l2.ProjectPath,
            projectDir,
            "Gsharp.NET.Sdk/" + sdk.Version,
            generatedProjectPaths: nil
        )
            .Save(generatedProjectPath, SaveOptions.DisableFormatting)
        Assert.Single(
            XDocument.Load(generatedProjectPath).Descendants(),
            (element XElement) -> element.Name.LocalName == "InternalsVisibleTo" && element.Attribute(
                XName?("Include")!!
            )
                ?.Value == "L2-Library.Tests"
        )
        GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, sdk.NupkgPath)
        GsharpTestProjectRunner.WriteIsolationBoundary(projectDir)
        let build = ProcessRunner.Run(
            "dotnet",
            []string{
                "build",
                generatedProjectPath,
                "-c",
                "Release",
                "-p:RestoreConfigFile=" + Path.Combine(repoRoot, "nuget.config")
            },
            projectDir,
            TimeSpan.FromMinutes(5)
        )
        Assert.True(build.ExitCode == 0, build.Output)
        let assemblyPath = Path.Combine(projectDir, "bin", "Release", "net10.0", "L2-Library.dll")
        AssertFriendAssemblies(assemblyPath)
    }

    /// The repository layout splits a file that declares several namespaces
    /// into one G# unit per namespace. A global-namespace declaration in that
    /// file belongs to no namespace, so it must land in exactly one unit (the
    /// first) instead of matching no unit's package filter and vanishing.
    @Fact
    async func RepositoryTranslate_MultiNamespaceFile_KeepsItsGlobalDeclarations() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let sourceRoot = NewOutputRoot("split-global-source")
        let app = CreateFriendAssemblyFixture(corpus, sourceRoot)
        let sourceDir string? = Path.GetDirectoryName(app.ProjectPath)
        File.Delete(Path.Combine(sourceDir!!, "FriendAssembly.cs"))
        File.WriteAllText(Path.Combine(sourceDir!!, "Mixed.cs"), `namespace Split.Deep.Inner
{
    public sealed class DeepThing
    {
    }
}

namespace Split
{
    public sealed class ShallowThing
    {
    }
}

public sealed class GlobalThing
{
    public static int Value => 7;
}

public delegate void GlobalCallback();`)
        let destinationRoot = NewOutputRoot("split-global")
        let projectDir = Path.Combine(destinationRoot, "L2-Library")
        Directory.CreateDirectory(projectDir)
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: sourceRoot,
            OutputRoot: destinationRoot,
            OutputLayout: MigrationOutputLayout.Repository,
            RepositoryAdditionalFiles: HashSet[string](StringComparer.OrdinalIgnoreCase)
        }
        let context = StageExecutionContext(
            app,
            options,
            GscInvoker(compiler),
            projectDir,
            TriageBuilder("run", "2026-09-24T00:00:00Z", "test", app.Id)
        )
        let translation = await TranslateStage().ExecuteAsync(context)
        Assert.Equal(StageStatus.Passed, translation.Status)
        let units = Directory
            .GetFiles(projectDir, "Mixed*.gs")
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        Assert.Equal(2, units.Length)
        let primary = File.ReadAllText(Path.Combine(projectDir, "Mixed.gs"))
        Assert.StartsWith("package Split", primary, StringComparison.Ordinal)
        Assert.DoesNotContain("package Split.Deep", primary, StringComparison.Ordinal)
        Assert.Contains("class GlobalThing", primary, StringComparison.Ordinal)
        Assert.Contains("GlobalCallback", primary, StringComparison.Ordinal)
        Assert.Equal(
            1,
            units.Count((path string) -> File.ReadAllText(path).Contains("class GlobalThing", StringComparison.Ordinal))
        )
        Assert.Equal(
            1,
            units.Count((path string) -> File.ReadAllText(path).Contains("GlobalCallback", StringComparison.Ordinal))
        )
    }

    /// Pointing the pipeline at `corpus/CompileGap-Library` translates
    /// cleanly but reaches the compile stage and captures a
    /// `compile-error` triage artifact. That fixture exists solely to
    /// exercise this machinery: its body translates to valid G# yet references
    /// an undefined helper, so `gsc` rejects it with a stable diagnostic
    /// regardless of which real compiler gaps are open or closed (the earlier
    /// anchor, `corpus/L3-Library`, now compiles green). The artifact
    /// carries a non-empty diagnostic id and a stable `sha256:`
    /// fingerprint. Gated on compiler presence (the pipeline resolves
    /// `gsc` up front).
    @Fact
    async func CompileStageFailure_WritesTriageArtifact() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("compilegap-capture")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options)
        let l3 = CorpusDiscovery.FindById(corpus, "corpus/CompileGap-Library")!!
        let result = await pipeline.RunAsync([]CorpusApp{l3})
        let app = Assert.Single(result.Apps)
        Assert.False(app.Succeeded)
        Assert.Equal("compile-error", app.FailureCategory)
        Assert.NotEmpty(app.Artifacts)
        let artifactPath = Path.Combine(outRoot, result.RunId, app.Artifacts[0])
        Assert.True(File.Exists(artifactPath), "the triage artifact file must be written: " + artifactPath)
        let artifact TriageArtifact? = JsonSerializer.Deserialize[TriageArtifact](
            File.ReadAllText(artifactPath),
            TriageSerialization.Options
        )
        Assert.Equal("compile-error", artifact!!.Category)
        Assert.False(string.IsNullOrEmpty(artifact!!.Diagnostic!!.Id))
        Assert.StartsWith("sha256:", artifact!!.Fingerprint, StringComparison.Ordinal)
    }

    /// Re-running against the same `--gsc` carries the prior run forward in
    /// each fingerprint's `retryHistory` (the §C retry mechanism). Anchored
    /// on `corpus/CompileGap-Library`, whose synthetic body always fails at
    /// the compile stage (an undefined-helper reference), so the machinery is
    /// exercised independent of the corpus's evolving compile health.
    /// Gated on compiler presence.
    @Fact
    async func RetryHistory_AccumulatesAcrossRuns_ForSameFingerprint() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("retry")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let l3 = CorpusDiscovery.FindById(corpus, "corpus/CompileGap-Library")!!
        let first = await MigrationPipeline(options).RunAsync([]CorpusApp{l3})
        let second = await MigrationPipeline(options).RunAsync([]CorpusApp{l3})
        Assert.NotEqual(first.RunId, second.RunId)
        let secondArtifact = Path.Combine(outRoot, second.RunId, second.Apps[0].Artifacts[0])
        let artifact TriageArtifact? = JsonSerializer.Deserialize[TriageArtifact](
            File.ReadAllText(secondArtifact),
            TriageSerialization.Options
        )
        Assert.NotEmpty(artifact!!.RetryHistory)
        Assert.Contains(artifact!!.RetryHistory, (e TriageRetryEntry) -> e.RunId == first.RunId)
        Assert.All(artifact!!.RetryHistory, (e TriageRetryEntry) -> Assert.Equal("fail", e.Result))
    }

    /// Issue #1751 regression guard: a prior run directory that also contains a
    /// stage-4 (test-parity) NuGet-restore scaffold under
    /// `<appDir>/test-parity/<Lib>/obj/` (e.g.
    /// `project.assets.json`, `*.nuget.dgspec.json`) must not have
    /// those decoy JSON files opened at all — (cref:LoadPriorRetryEntries)
    /// (reached via reflection since it is a pipeline-internal helper) is
    /// scoped to exactly the writer's layout, `<runDir>/<appDir>/*.json`
    /// (top-level only), so it never descends into `obj/`. The decoy
    /// files are chmod'd unreadable as a canary: were they opened, the
    /// unhandled (cref:UnauthorizedAccessException) would fail this
    /// test loudly (only (cref:JsonException)/(cref:IOException)
    /// are swallowed by `TryReadArtifact`). Skipped on Windows, which has
    /// no POSIX permission bits to enforce the canary.
    @Fact
    func LoadPriorRetryEntries_IgnoresObjArtifacts_AndDoesNotDescendIntoThem() {
        if RuntimeInformation.IsOSPlatform(OSPlatform.Windows) {
            return
        }
        let outputRoot = NewOutputRoot("retry-scan-scope")
        let priorRunDir = Path.Combine(outputRoot, "2026-01-01T00-00-00Z_aaaaaa")
        let appDir = Path.Combine(priorRunDir, "corpus_Sample")
        Directory.CreateDirectory(appDir)
        // The real retry-entry artifact: written by WriteArtifacts() directly
        // under the app's run directory as "<stage>-<12hex fingerprint>.json".
        let builder = TriageBuilder("2026-01-01T00-00-00Z_aaaaaa", "2026-01-01T00:00:00Z", "0.2.0+abc", "corpus/Sample")
        let diagnostic = GscDiagnostic("GS0100", "no overload for 'g'", "error", "Sample.gs", 2, 13)
        let real = builder.CompileError(diagnostic, nil)
        let realFile = Path.Combine(appDir, "compile-" + FingerprintShort(real.Fingerprint) + ".json")
        File.WriteAllText(realFile, JsonSerializer.Serialize(real, TriageSerialization.Options))
        // Decoy stage-4 NuGet/MSBuild artifacts nested under obj/, exactly the
        // layout GsharpTestProjectRunner.Run() scaffolds
        // (<appDir>/test-parity/<Lib>/obj/*.json). Made unreadable so any
        // attempt to open them throws instead of silently succeeding.
        let objDir = Path.Combine(appDir, "test-parity", "Sample", "obj")
        Directory.CreateDirectory(objDir)
        let decoys[]string = []string{
            Path.Combine(objDir, "project.assets.json"),
            Path.Combine(objDir, "Sample.csproj.nuget.dgspec.json"),
            Path.Combine(objDir, "Sample.csproj.nuget.g.props.json")
        }
        for decoy in decoys {
            File.WriteAllText(decoy, String('x', 1024)) // not even valid JSON
            File.SetUnixFileMode(decoy, UnixFileMode.None) // canary: reading this throws

        }
        try {
            let method MethodInfo? = typeof(MigrationPipeline).GetMethod(
                "LoadPriorRetryEntries",
                BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(method)
            let result IReadOnlyDictionary[string, List[TriageRetryEntry]]? = cast[
                IReadOnlyDictionary[string, List[TriageRetryEntry]]
            ](method!!.Invoke(nil, []object{outputRoot, "2026-01-02T00-00-00Z_bbbbbb"}))
            let entry = Assert.Single(Assert.Single(result!!).Value)
            Assert.Equal("2026-01-01T00-00-00Z_aaaaaa", entry.RunId)
            Assert.Single(result!!) // exactly the one real fingerprint, nothing from the decoys

        } finally {
            // Restore permissions so test cleanup (temp-dir deletion) can proceed.
            for decoy in decoys {
                File.SetUnixFileMode(decoy, UnixFileMode.UserRead | UnixFileMode.UserWrite)
            }
        }
    }

    /// A stage-2 skip (e.g. a genuinely-unavailable dependency) with no
    /// failing stage rolls up to an app that is (cref:AppResult.Unverified)
    /// but still (cref:AppResult.Succeeded), and a run that is
    /// (cref:RunResult.Unverified) but still (cref:RunResult.Succeeded)
    /// — never "green" but also never exiting non-zero (issue #1831).
    @Fact
    async func SkippedStage_NoFailure_RollsUpToUnverified_NotGreen_AppAndRun() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("skip-rollup")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(
            options,
            []IMigrationStage{PassStage(MigrationStageKind.Translate), SkipStage(MigrationStageKind.Compile)}
        )
        let l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console")!!
        Assert.NotNull(l1)
        let result = await pipeline.RunAsync([]CorpusApp{l1})
        let app = Assert.Single(result.Apps)
        Assert.True(app.Succeeded)
        Assert.True(app.Unverified)
        Assert.True(result.Succeeded)
        Assert.True(result.Unverified)
    }

    /// A failed stage takes precedence over a later skip in the same app: the
    /// app and run are "Failed" ((cref:AppResult.Succeeded) /
    /// (cref:RunResult.Succeeded) both `false`), never
    /// "Unverified" — the general rollup precedence is Failed > Skipped >
    /// Green (issue #1831).
    @Fact
    async func FailedStage_TakesPrecedenceOverSkip_AppAndRunAreFailed_NotUnverified() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("fail-precedence")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{FailStage(MigrationStageKind.Translate)})
        let l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console")!!
        Assert.NotNull(l1)
        let result = await pipeline.RunAsync([]CorpusApp{l1})
        let app = Assert.Single(result.Apps)
        Assert.False(app.Succeeded)
        Assert.False(app.Unverified)
        Assert.False(result.Succeeded)
        Assert.False(result.Unverified)
    }

    /// Stage progress names the active app/stage before work starts, then reports
    /// its pass/fail result and elapsed time after the stage completes.
    @Fact
    async func StageProgress_ReportsStartBeforePassOrFail_WithElapsedTime() {
        let outRoot = NewOutputRoot("stage-progress")
        let projectPath = Path.Combine(outRoot, "Progress.csproj")
        File.WriteAllText(projectPath, "<Project />")
        let options = PipelineOptions{GscPath: typeof(MigrationPipeline).Assembly.Location, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(
            options,
            []IMigrationStage{PassStage(MigrationStageKind.Translate), FailStage(MigrationStageKind.Compile)}
        )
        let app = CorpusApp("tests/Progress", projectPath, TargetKind.Library)
        let originalOut = Console.Out
        using let captured = StringWriter()
        try {
            Console.SetOut(captured)
            await pipeline.RunAsync([]CorpusApp{app})
        } finally {
            Console.SetOut(originalOut)
        }
        let lines = captured.ToString().Split([]char{'\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        let translateStart = Array.IndexOf(lines, "cs2gs: tests/Progress: translate started.")
        let translatePass = Array.FindIndex(
            lines,
            (line string) -> line.StartsWith("cs2gs: tests/Progress: translate passed in ", StringComparison.Ordinal)
        )
        let compileStart = Array.IndexOf(lines, "cs2gs: tests/Progress: compile started.")
        let compileFail = Array.FindIndex(
            lines,
            (line string) -> line.StartsWith("cs2gs: tests/Progress: compile failed in ", StringComparison.Ordinal)
        )
        Assert.True(translateStart >= 0)
        Assert.True(translateStart < translatePass)
        Assert.True(translatePass < compileStart)
        Assert.True(compileStart < compileFail)
        Assert.Matches("^cs2gs: tests/Progress: translate passed in [0-9]+\\.[0-9]s\\.$$", lines[translatePass])
        Assert.Matches("^cs2gs: tests/Progress: compile failed in [0-9]+\\.[0-9]s\\.$$", lines[compileFail])
    }

    /// A fixed-outcome stage double, used to drive pipeline rollup tests deterministically.
    private class PassStage : IMigrationStage {
        init(kind MigrationStageKind) {
            this.Kind = kind
        }

        prop Kind MigrationStageKind {
            get;
        }

        func ExecuteAsync(
            context StageExecutionContext,
            cancellationToken CancellationToken = default(CancellationToken)
        ) Task[StageOutcome] -> Task.FromResult(StageOutcome.Passed())
    }

    /// A fixed-outcome stage double that reports (cref:StageStatus.Skipped).
    private class SkipStage : IMigrationStage {
        init(kind MigrationStageKind) {
            this.Kind = kind
        }

        prop Kind MigrationStageKind {
            get;
        }

        func ExecuteAsync(
            context StageExecutionContext,
            cancellationToken CancellationToken = default(CancellationToken)
        ) Task[StageOutcome] -> Task.FromResult(StageOutcome.Skipped())
    }

    /// A fixed-outcome stage double that reports (cref:StageStatus.Failed).
    private class FailStage : IMigrationStage {
        init(kind MigrationStageKind) {
            this.Kind = kind
        }

        prop Kind MigrationStageKind {
            get;
        }

        func ExecuteAsync(
            context StageExecutionContext,
            cancellationToken CancellationToken = default(CancellationToken)
        ) Task[StageOutcome] -> Task.FromResult(StageOutcome.Failed(Array.Empty[TriageArtifact]()))
    }

    shared {
        private func CreateFriendAssemblyFixture(corpus string?, sourceRoot string) CorpusApp {
            let original = CorpusDiscovery.FindById(corpus, "corpus/L2-Library")!!
            let projectDir = Path.Combine(sourceRoot, "L2-Library")
            Directory.CreateDirectory(projectDir)
            File.Copy(
                Path.Combine(corpus!!, "Directory.Build.props"),
                Path.Combine(sourceRoot, "Directory.Build.props")
            )
            let projectPath = Path.Combine(projectDir, Path.GetFileName(original.ProjectPath))
            File.Copy(original.ProjectPath, projectPath)
            File.WriteAllText(
                projectPath,
                File.ReadAllText(projectPath).Replace(
                    "<PropertyGroup>",
                    "<PropertyGroup>" + Environment.NewLine + "    <TargetFramework>net10.0</TargetFramework>",
                    StringComparison.Ordinal
                )
            )
            File.WriteAllText(Path.Combine(projectDir, "FriendAssembly.cs"), `[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("L2-Library.Source.Tests")]

public sealed class Marker
{
}`)
            return CorpusApp(
                original.Id,
                projectPath,
                original.TargetKind,
                relativeProjectPath: Path.Combine("L2-Library", Path.GetFileName(projectPath))
            )
        }

        private func AssertFriendAssemblies(assemblyPath string) {
            let assembly = Assembly.LoadFile(assemblyPath)
            let friendAssemblies = assembly
                .GetCustomAttributesData()
                .Where(
                (attribute CustomAttributeData) -> attribute.AttributeType == typeof(InternalsVisibleToAttribute)
            )
                .Select(
                (attribute CustomAttributeData) -> cast[string](Assert.Single(attribute.ConstructorArguments).Value)
            )
                .OrderBy((name string) -> name, StringComparer.Ordinal)
                .ToArray()
            Assert.Equal([]string{"L2-Library.Source.Tests", "L2-Library.Tests"}, friendAssemblies)
        }

        private func FingerprintShort(fingerprint string) string {
            let hex = if fingerprint.StartsWith("sha256:", StringComparison.Ordinal) {
                fingerprint.Substring("sha256:".Length)
            } else {
                fingerprint
            }
            return if hex.Length <= 12 {
                hex
            } else {
                hex.Substring(0, 12)
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

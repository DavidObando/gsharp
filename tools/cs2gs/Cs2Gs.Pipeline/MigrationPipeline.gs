// <copyright file="MigrationPipeline.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Security.Cryptography
import System.Text
import System.Text.Json
import System.Threading
import System.Threading.Tasks
import Cs2Gs.Translator.Loading
import System.Xml.Linq

/// The spine of the C#→G# migration tool (ADR-0115 §C): it runs an ordered
/// (cref:IReadOnlyList{IMigrationStage}) per corpus app, short-circuiting
/// on the first failure, and writes the per-failure triage artifacts (§D) plus
/// the machine-readable run summary (§F) under the run directory. Stages 3
/// (`ilverify`) and 4 (`test-parity`) slot in by appending two more
/// (cref:IMigrationStage) implementations to (cref:Stages).
class MigrationPipeline {
    private let options PipelineOptions

    /// Initializes a new instance of the (cref:MigrationPipeline) class.
    /// @param options The whole-run options.
    /// @param stages The ordered stages to execute; when `null` the default
    /// stages 1–2 ((cref:TranslateStage), (cref:CompileStage)) are
    /// used.
    init(options PipelineOptions, stages IReadOnlyList[IMigrationStage]? = nil) {
        this.options = options ?? throw ArgumentNullException("options")
        this.Stages = stages ?? DefaultStages()
    }

    /// Gets the ordered stages this pipeline executes.
    prop Stages IReadOnlyList[IMigrationStage] {
        get;
    }

    /// Executes the pipeline over the supplied apps, writing all artifacts and
    /// the run summary, and returns the machine-readable run result.
    /// @param apps The corpus apps to migrate, in order.
    /// @param cancellationToken A cancellation token.
    /// @returns The whole-run result.
    /// @exception InvalidOperationException No `gsc.dll` could be resolved.
    async func RunAsync(
        apps IReadOnlyList[CorpusApp]?,
        cancellationToken CancellationToken = default(CancellationToken)
    ) RunResult {
        if apps == nil {
            throw ArgumentNullException("apps")
        }
        let gscPath string? = GscInvoker.Resolve(
            this.options.GscPath,
            this.options.Config,
            Directory.GetCurrentDirectory()
        )
        if gscPath == nil {
            throw InvalidOperationException(
                "Could not resolve gsc.dll. Build the repository solution or pass --gsc <path>."
            )
        }
        // Issue #2215: best-effort — an app with no analyzer references never
        // touches this path (gsc's own /analyzer: fast path is a no-op), so a
        // missing gsgen.dll here is not fatal; it only matters for apps whose
        // project references generators.
        let gsgenPath string? = GscInvoker.ResolveGsgenTool(
            this.options.GsgenPath,
            this.options.Config,
            Path.GetDirectoryName(gscPath)!!,
            Directory.GetCurrentDirectory()
        )
        let gsc = GscInvoker(gscPath, gsgenPath)
        let gscVersion string? = gsc.GetVersion()
        let nowUtc = DateTime.UtcNow
        let runId = NewRunId(nowUtc)
        let timestamp = nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture)
        let repositoryLayout = this.options.OutputLayout == MigrationOutputLayout.Repository
        if repositoryLayout && string.IsNullOrWhiteSpace(this.options.OutputRoot) {
            throw InvalidOperationException("Repository migration requires an output directory.")
        }
        let destinationRoot string? = if repositoryLayout {
            Path.GetFullPath(this.options.OutputRoot!!)
        } else {
            default(string?)
        }
        let outputRoot = if repositoryLayout {
            Path.GetFullPath(this.options.ArtifactRoot ?? destinationRoot + ".cs2gs-runs")
        } else {
            Path.GetFullPath(this.options.OutputRoot ?? Path.Combine(Directory.GetCurrentDirectory(), "cs2gs-runs"))
        }
        if repositoryLayout {
            let relativeArtifactPath = Path.GetRelativePath(destinationRoot!!, outputRoot)
            if !Path.IsPathRooted(relativeArtifactPath) && !relativeArtifactPath.Equals(
                "..",
                StringComparison.Ordinal
            ) &&
                !relativeArtifactPath.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
                !relativeArtifactPath
                .StartsWith(".." + Path.AltDirectorySeparatorChar, StringComparison.Ordinal) {
                throw InvalidOperationException(
                    "Repository validation artifacts must be outside the destination directory."
                )
            }
        }
        let runDir = Path.Combine(outputRoot, runId)
        this
            .options
            .GeneratedProjectPaths = BuildGeneratedProjectPaths(
            apps,
            this.options.PassthroughProjectPaths,
            this.options.SourceRoot,
            destinationRoot,
            runDir,
            repositoryLayout
        )
        var repositoryFiles IReadOnlyList[string]? = nil
        if repositoryLayout {
            repositoryFiles = RepositoryMirror.Prepare(
                this.options.SourceRoot,
                destinationRoot,
                this.options.GeneratedProjectPaths
            )
            let verbatimWarnings = List[string]()
            RepositoryVerbatimSources.Compute(this.options.SourceRoot, repositoryFiles, verbatimWarnings)
            for warning in verbatimWarnings {
                Console.Error.WriteLine("cs2gs: warning: " + warning)
            }
            this
                .options
                .RepositorySourceFiles = repositoryFiles
                .Where((path string) -> Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase))
                .Select((path string) -> Path.GetFullPath(Path.Combine(this.options.SourceRoot!!, path)))
                .ToHashSet(StringComparer.OrdinalIgnoreCase)
            this.options.RepositoryTranslations = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
            this
                .options
                .RepositoryEmittedOutputs = Dictionary[string, (Source string, Text string)](
                StringComparer.OrdinalIgnoreCase
            )
            this.options.RepositoryAdditionalFiles = HashSet[string](StringComparer.OrdinalIgnoreCase)
        }
        Directory.CreateDirectory(runDir)
        let evaluatedProjectReferences = await this.LoadEvaluatedProjectReferencesAsync(
            apps,
            includeBuildOrdering: true,
            cancellationToken
        )
            .ConfigureAwait(false)
        // Issue #3645: an executable app that another app in this run compiles
        // against must keep its entry-point class as a real G# class (see
        // PipelineOptions.ProjectsReferencedByOtherApps).
        this.options.ProjectsReferencedByOtherApps = DeclaredProjectItems.CollectCompileReferencedProjectPaths(
            apps.Select((app CorpusApp) -> app.ProjectPath),
            evaluatedProjectReferences
        )
        let excludedScope RepositoryExcludedScope? = if repositoryLayout {
            RepositoryExcludedScope.Compute(this.options.SourceRoot, this.options.ExcludedProjectPaths)
        } else {
            default(RepositoryExcludedScope?)
        }
        var passthroughCompileSources IReadOnlyDictionary[string, IReadOnlyList[string]]? = nil
        if repositoryLayout && this.options.PassthroughProjectPaths.Count > 0 {
            let sources = Dictionary[string, IReadOnlyList[string]](StringComparer.OrdinalIgnoreCase)
            for projectPath in this.options.PassthroughProjectPaths {
                let project = await CSharpProjectLoader.LoadProjectAsync(projectPath, cancellationToken).ConfigureAwait(
                    false
                )
                // LoadProjectAsync returns a project or throws.
                sources[Path.GetFullPath(projectPath)] = CompileSourcePaths(project)
            }
            passthroughCompileSources = sources
        }
        let passthroughScope RepositoryExcludedScope? = if repositoryLayout {
            RepositoryExcludedScope.Compute(
                this.options.SourceRoot,
                this.options.PassthroughProjectPaths,
                passthroughCompileSources
            )
        } else {
            default(RepositoryExcludedScope?)
        }
        if repositoryLayout {
            let sdkVersion string? = SdkCompileRunner.ResolveSdkVersion(this.options.Config, this.options.SdkVersion)
            if sdkVersion == nil {
                throw InvalidOperationException(
                    "Could not resolve a local Gsharp.NET.Sdk package for the mirrored projects."
                )
            }
            if this.options.SdkPinLocation == SdkPinLocation.GlobalJson {
                if SdkPin.WriteGlobalJsonPin(destinationRoot, sdkVersion) {
                    this.options.RepositoryAdditionalFiles!!.Add(SdkPin.GlobalJsonFileName)
                }
                for nestedGlobalJson in SdkPin.EnumerateNestedGlobalJson(destinationRoot, repositoryFiles) {
                    SdkPin.WriteGlobalJsonPinFile(Path.Combine(destinationRoot!!, nestedGlobalJson), sdkVersion)
                }
            } else {
                let mirroredGlobalJsonPin string? = SdkPin.ReadGlobalJsonScopePin(destinationRoot)
                if mirroredGlobalJsonPin != nil {
                    // A versioned Sdk attribute silently overrides a global.json
                    // msbuild-sdks pin, and validate takes a pinned global.json to
                    // mean the tree is in global-json mode. Mixing the two would
                    // build different projects against different SDKs.
                    throw InvalidOperationException(
                        "The repository global.json (mirrored from the source) already pins Gsharp.NET.Sdk " +
                            mirroredGlobalJsonPin +
                            "; migrate with --sdk-pin global-json."
                    )
                }
            }
            let sdkMoniker = SdkPin.ProjectSdkAttribute(sdkVersion, this.options.SdkPinLocation)
            this.options.RepositorySdkMoniker = sdkMoniker
            this.options.RepositorySdkVersion = sdkVersion
            // Issue #3780: resolved once, up front, like sdkMoniker above.
            // Not every repository migration includes an analyzer test
            // project, so a missing local nupkg is not fatal here — it is
            // only an error if TranslateStage later needs it for a specific
            // project and finds this null.
            this
                .options
                .RepositoryAnalyzerVerifierPackageVersion = SdkCompileRunner.ResolveAnalyzerVerifierPackageVersion(
                this.options.Config,
                this.options.SdkVersion
            )
            for app in apps {
                let generatedProjectPath = this.options.GeneratedProjectPaths!![Path.GetFullPath(app.ProjectPath)]
                Directory.CreateDirectory(Path.GetDirectoryName(generatedProjectPath)!!)
                let transformed = GSharpProjectTransformer.Transform(
                    app.ProjectPath,
                    Path.GetDirectoryName(generatedProjectPath),
                    sdkMoniker,
                    this.options.GeneratedProjectPaths
                )
                transformed.Save(generatedProjectPath, SaveOptions.DisableFormatting)
            }
            // Issue #3772: an excluded project with nothing to translate still
            // belongs in the mirror — dropping only its project file leaves a
            // half project its consumers cannot reference.
            for mirroredProject in RepositoryMirror.MirrorExcludedProjects(
                this.options.SourceRoot,
                destinationRoot,
                repositoryFiles,
                excludedScope,
                this.options.GeneratedProjectPaths,
                sdkMoniker
            ) {
                this.options.RepositoryAdditionalFiles!!.Add(mirroredProject)
            }
            for passthroughFile in RepositoryMirror.MirrorPassthroughProjects(
                this.options.SourceRoot,
                destinationRoot,
                repositoryFiles,
                passthroughScope,
                this.options.GeneratedProjectPaths
            ) {
                this.options.RepositoryAdditionalFiles!!.Add(passthroughFile)
            }
            RepositoryMirror.RebindMirroredSdkFiles(destinationRoot, sdkMoniker)
            // Issue #3862: the mirror must BE a repository before anything runs
            // inside it, not only after. Repository-anchored code — a test that
            // walks up from its output directory looking for `GSharp.sln`, an
            // MSBuild target that resolves a path relative to the solution —
            // executes during the per-app stage loop below (compile, ilverify
            // and `dotnet test` all run in the mirror). Generating the
            // solutions after that loop left every such probe looking at a tree
            // whose root anchor did not exist yet, which failed 37 of the 86
            // migrated `test/Sdk.Tests` tests. Nothing here depends on stage
            // output: the project mapping is complete above.
            RepositorySolutionGenerator.Generate(
                this.options.SourceRoot,
                destinationRoot,
                this.options.GeneratedProjectPaths,
                repositoryFiles
            )
            let loadedProjects = Dictionary[string, LoadedCSharpProject](StringComparer.OrdinalIgnoreCase)
            for app in apps {
                let projectPath = Path.GetFullPath(app.ProjectPath)
                loadedProjects[projectPath] = (
                    await CSharpProjectLoader.LoadProjectAsync(
                        projectPath,
                        cancellationToken,
                        includeAutoGenerated: true,
                        includedAutoGeneratedPaths: this.options.RepositorySourceFiles
                    )
                        .ConfigureAwait(false)
                )
            }
            this.options.RepositoryLoadedProjects = loadedProjects
        }
        let priorHistory = LoadPriorRetryEntries(outputRoot, runId)
        let runResult = RunResult{
            RunId: runId,
            Timestamp: timestamp,
            GscVersion: gscVersion,
            GscPath: gscPath,
            Succeeded: true
        }
        let appResults = Dictionary[string, AppResult](StringComparer.OrdinalIgnoreCase)
        let orderedApps = this.OrderForSdkBuild(apps, evaluatedProjectReferences)
        for app in orderedApps {
            cancellationToken.ThrowIfCancellationRequested()
            let appResult = await this.RunAppAsync(
                app,
                gsc,
                gscVersion,
                runId,
                timestamp,
                runDir,
                priorHistory,
                cancellationToken
            )
                .ConfigureAwait(false)
            appResults[app.Id] = appResult
            if !appResult.Succeeded {
                runResult.Succeeded = false
            }
        }
        for app in apps {
            runResult.Apps.Add(appResults[app.Id])
        }
        if repositoryLayout {
            if runResult.Succeeded {
                // Issue #3580: an orphan-mirror failure marks the run failed
                // (the nightly gate must still catch a checked-in C# file with
                // no translatable mirror) but no longer throws — the report
                // table and run.json land either way.
                let orphanFailures = RepositoryOrphanSourceTranslator.TranslateMissing(
                    this.options.SourceRoot,
                    destinationRoot,
                    repositoryFiles,
                    excludedScope
                )
                if orphanFailures.Count > 0 {
                    runResult.Succeeded = false
                    for failure in orphanFailures {
                        Console.Error.WriteLine("cs2gs: " + failure)
                    }
                }
            }
            if runResult.Succeeded {
                try {
                    RepositoryMirror.ValidateCompleted(
                        this.options.SourceRoot,
                        destinationRoot,
                        repositoryFiles,
                        this.options.RepositoryAdditionalFiles,
                        excludedScope,
                        this.options.RepositoryTranslations!!.Keys
                    )
                } catch (ex InvalidOperationException) {
                    // Issue #3580: same recorded-not-thrown contract as the
                    // orphan step — completeness failures gate the run but
                    // must not eat the report.
                    runResult.Succeeded = false
                    Console.Error.WriteLine("cs2gs: " + ex.Message)
                }
            }
        } else {
            SolutionGenerator.Generate(this.options.SourceRoot, runDir, this.options.GeneratedProjectPaths)
        }
        if this.options.PartialRun {
            // Issue #4853: stages after the requested last stage never ran, so a
            // passing app is "not verified" rather than green (issue #1831).
            for partialApp in runResult.Apps.Where((a AppResult) -> a.Succeeded) {
                partialApp.Unverified = true
            }
        }
        if runResult.Succeeded && runResult.Apps.Any((a AppResult) -> a.Unverified) {
            runResult.Unverified = true
        }
        let runJsonPath = Path.Combine(runDir, "run.json")
        File.WriteAllText(runJsonPath, JsonSerializer.Serialize(runResult, TriageSerialization.Options))
        return runResult
    }

    /// Validates an ALREADY-migrated repository tree for a subset of its apps
    /// (issue #3668). Runs this pipeline's stages — normally compile →
    /// ilverify → test-parity — against the migrated tree at
    /// (cref:PipelineOptions.OutputRoot), rehydrating each app's
    /// translate-derived state from the (cref:ValidationManifest) the
    /// whole-repository `migrate` pass wrote, and returns a PARTIAL
    /// (cref:RunResult) covering only [`selectedApps`](paramref).
    ///
    /// [`allApps`](paramref) must be the COMPLETE app list of the migrate
    /// run (same `--exclude` set), because the mirrored project map every
    /// stage resolves `ProjectReference`s through is repository-wide.
    /// Narrowing it — for instance by excluding the projects a shard does not
    /// own — breaks reference resolution and manufactures phantom cascades.
    /// @param allApps Every app in the migrated tree, in discovery order.
    /// @param selectedApps The subset this shard validates.
    /// @param manifestRunDir The migrate run directory holding the per-app manifests.
    /// @param cancellationToken A cancellation token.
    /// @returns The partial run result for [`selectedApps`](paramref).
    /// @exception InvalidOperationException No `gsc.dll` could be resolved.
    async func ValidateAsync(
        allApps IReadOnlyList[CorpusApp]?,
        selectedApps IReadOnlyList[CorpusApp]?,
        manifestRunDir string,
        cancellationToken CancellationToken = default(CancellationToken)
    ) RunResult {
        if allApps == nil {
            throw ArgumentNullException("allApps")
        }
        if selectedApps == nil {
            throw ArgumentNullException("selectedApps")
        }
        if string.IsNullOrWhiteSpace(this.options.OutputRoot) {
            throw InvalidOperationException("Validation requires --migrated <existing-migrated-tree>.")
        }
        let migratedRoot = Path.GetFullPath(this.options.OutputRoot!!)
        if !Directory.Exists(migratedRoot) {
            throw InvalidOperationException("Migrated tree '$migratedRoot' does not exist.")
        }
        this.options.OutputLayout = MigrationOutputLayout.Repository
        let gscPath string? = GscInvoker.Resolve(
            this.options.GscPath,
            this.options.Config,
            Directory.GetCurrentDirectory()
        )
        if gscPath == nil {
            throw InvalidOperationException(
                "Could not resolve gsc.dll. Build the repository solution or pass --gsc <path>."
            )
        }
        let gsgenPath string? = GscInvoker.ResolveGsgenTool(
            this.options.GsgenPath,
            this.options.Config,
            Path.GetDirectoryName(gscPath)!!,
            Directory.GetCurrentDirectory()
        )
        let gsc = GscInvoker(gscPath, gsgenPath)
        let gscVersion string? = gsc.GetVersion()
        let nowUtc = DateTime.UtcNow
        let runId = NewRunId(nowUtc)
        let timestamp = nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture)
        let outputRoot = Path.GetFullPath(this.options.ArtifactRoot ?? migratedRoot + ".cs2gs-runs")
        let runDir = Path.Combine(outputRoot, runId)
        Directory.CreateDirectory(runDir)
        // The mirrored-project map is repository-wide by construction: it is
        // the same map the migrate pass built, computed from the full app list
        // and the migrated tree root.
        this
            .options
            .GeneratedProjectPaths = BuildGeneratedProjectPaths(
            allApps,
            this.options.PassthroughProjectPaths,
            this.options.SourceRoot,
            migratedRoot,
            runDir,
            repositoryLayout: true
        )
        this.ResolveValidationSdkPin(migratedRoot)
        let evaluatedProjectReferences = await this.LoadEvaluatedProjectReferencesAsync(
            allApps,
            includeBuildOrdering: false,
            cancellationToken
        )
            .ConfigureAwait(false)
        this.options.ProjectsReferencedByOtherApps = DeclaredProjectItems.CollectCompileReferencedProjectPaths(
            allApps.Select((app CorpusApp) -> app.ProjectPath),
            evaluatedProjectReferences
        )
        let priorHistory = LoadPriorRetryEntries(outputRoot, runId)
        let runResult = RunResult{
            RunId: runId,
            Timestamp: timestamp,
            GscVersion: gscVersion,
            GscPath: gscPath,
            Succeeded: true
        }
        for app in selectedApps {
            cancellationToken.ThrowIfCancellationRequested()
            let context = this.CreateAppContext(app, gsc, gscVersion, runId, timestamp, runDir, out var artifactDir)
            let manifest ValidationManifest? = ValidationManifest.Read(
                Path.Combine(
                    manifestRunDir ?? string.Empty,
                    ArtifactDirectoryName(app.Id, MigrationOutputLayout.Repository)
                )
            )
            if manifest == nil {
                throw InvalidOperationException(
                    "No ${ValidationManifest.FileName} for app '${app.Id}' under '$manifestRunDir'. " +
                        "Validation shards must run against the artifacts of the migrate pass that " +
                        "produced the migrated tree."
                )
            }
            if !manifest.Translated {
                // The app never got past stage 1, so it has no migrated sources
                // to compile and its verdict already exists in the migrate run.
                // Reporting it here would render an empty compile as a PASS and
                // inflate the green count; the merge takes the translate
                // failure from the migrate pass instead.
                Console.WriteLine("cs2gs validate: skipping '${app.Id}' — it did not translate.")
                continue
            }
            manifest.Hydrate(context, migratedRoot)
            let appResult = await this.RunStagesAsync(
                app,
                context,
                artifactDir,
                runDir,
                priorHistory,
                cancellationToken
            )
                .ConfigureAwait(false)
            runResult.Apps.Add(appResult)
            if !appResult.Succeeded {
                runResult.Succeeded = false
            }
        }
        if runResult.Succeeded && runResult.Apps.Any((a AppResult) -> a.Unverified) {
            runResult.Unverified = true
        }
        File.WriteAllText(
            Path.Combine(runDir, "run.json"),
            JsonSerializer.Serialize(runResult, TriageSerialization.Options)
        )
        return runResult
    }

    internal func OrderForSdkBuild(
        apps IReadOnlyList[CorpusApp],
        evaluatedProjectReferences IReadOnlyDictionary[string, IReadOnlyList[string]]?
    ) IReadOnlyList[CorpusApp] {
        if !this.options.CompileViaSdk || apps.Count <= 1 {
            return apps
        }
        let byPath = apps.ToDictionary(
            func (app CorpusApp) string {
                return Path.GetFullPath(app.ProjectPath)
            },
            StringComparer.OrdinalIgnoreCase
        )
        let ordered = List[CorpusApp](apps.Count)
        let visiting = HashSet[string](StringComparer.OrdinalIgnoreCase)
        let visited = HashSet[string](StringComparer.OrdinalIgnoreCase)
        let Visit = func (app CorpusApp) {
            let path = Path.GetFullPath(app.ProjectPath)
            if !visited.Add(path) {
                return
            }
            if !visiting.Add(path) {
                return
            }
            var evaluatedPaths IReadOnlyList[string]? = nil
            evaluatedProjectReferences?.TryGetValue(path, out evaluatedPaths)
            // Evaluated paths cover expression-based compile references; the
            // declared paths retain analyzer-only ordering edges (#3617).
            for referencePath in DeclaredProjectItems.ProjectReferencePaths(path, evaluatedPaths!!) {
                if byPath.TryGetValue(referencePath, out var dependency) {
                    Visit(dependency)
                }
            }
            visiting.Remove(path)
            ordered.Add(app)
        }
        for app in apps {
            Visit(app)
        }
        return ordered
    }

    /// Resolves the SDK pin a `validate` run builds the migrated tree
    /// with. The tree is the source of truth: when its `global.json` pins
    /// `Gsharp.NET.Sdk`, every project is re-transformed with the bare
    /// `Sdk` attribute and that version is staged, because a versioned
    /// attribute would silently override the tree's pin; otherwise the
    /// version its generated projects record is kept. An explicit
    /// (cref:PipelineOptions.SdkVersion) that disagrees with the tree is
    /// an error, never a tie-break. Only a tree that records no pin at all
    /// falls back to resolving one as `migrate` does.
    /// @param migratedRoot The migrated tree.
    private func ResolveValidationSdkPin(migratedRoot string) {
        let treePin string? = SdkPin.ReadGlobalJsonScopePin(migratedRoot)
        let projectPin string? = SdkPin.ReadProjectPin(
            SdkPin.BuildableSdkFilePaths(migratedRoot),
            if treePin == nil {
                SdkPinLocation.ProjectFile
            } else {
                SdkPinLocation.GlobalJson
            }
        )
        if treePin != nil && projectPin != nil {
            throw InvalidOperationException(
                "The migrated tree pins Gsharp.NET.Sdk both in global.json (" +
                    treePin +
                    ") and in its projects (" +
                    projectPin +
                    "); a versioned Sdk attribute overrides global.json."
            )
        }
        let recordedPin string? = treePin ?? projectPin
        if recordedPin != nil && this.options.SdkVersion != nil && !string.Equals(
            recordedPin,
            this.options.SdkVersion,
            StringComparison.Ordinal
        ) {
            throw InvalidOperationException(
                "--sdk-version " +
                    this
                    .options
                    .SdkVersion +
                    " disagrees with the migrated tree's pin (" +
                    recordedPin +
                    ")."
            )
        }
        let location = if treePin == nil {
            SdkPinLocation.ProjectFile
        } else {
            SdkPinLocation.GlobalJson
        }
        let requestedVersion string? = recordedPin ?? this.options.SdkVersion
        let sdkVersion string? = SdkCompileRunner.ResolveSdkVersion(this.options.Config, requestedVersion)
        // A null version is not thrown here: each app's compile reports the
        // missing package as an unavailable stage, as it always has.
        this.options.RepositorySdkMoniker = if sdkVersion == nil {
            default(string?)
        } else {
            SdkPin.ProjectSdkAttribute(sdkVersion, location)
        }
        this.options.RepositorySdkVersion = sdkVersion
        this.options.RepositoryAnalyzerVerifierPackageVersion = SdkCompileRunner.ResolveAnalyzerVerifierPackageVersion(
            this.options.Config,
            requestedVersion
        )
    }

    private async func LoadEvaluatedProjectReferencesAsync(
        apps IReadOnlyList[CorpusApp],
        includeBuildOrdering bool,
        cancellationToken CancellationToken
    ) IReadOnlyDictionary[string, IReadOnlyList[string]] {
        let references = Dictionary[string, IReadOnlyList[string]](StringComparer.OrdinalIgnoreCase)
        let loadAllForBuildOrdering = includeBuildOrdering && this.options.CompileViaSdk && apps.Count > 1
        for app in apps {
            let path = Path.GetFullPath(app.ProjectPath)
            let hasExpression = DeclaredProjectItems.Read(path, "ProjectReference").Any(
                DeclaredProjectItems.HasMsbuildExpressionInclude
            )
            if !loadAllForBuildOrdering && !hasExpression {
                continue
            }
            references[path] = await DeclaredProjectItems.EvaluateCompileProjectReferencePathsAsync(
                path,
                cancellationToken
            )
                .ConfigureAwait(false)
        }
        return references
    }

    private func CreateAppContext(
        app CorpusApp,
        gsc GscInvoker,
        gscVersion string?,
        runId string,
        timestamp string,
        runDir string,
        out artifactDir string
    ) StageExecutionContext {
        artifactDir = Path.Combine(runDir, ArtifactDirectoryName(app.Id, this.options.OutputLayout))
        let projectOutputDir string? = if this.options.OutputLayout == MigrationOutputLayout.Repository {
            Path.GetDirectoryName(this.options.GeneratedProjectPaths!![Path.GetFullPath(app.ProjectPath)])
        } else {
            artifactDir
        }
        Directory.CreateDirectory(artifactDir)
        Directory.CreateDirectory(projectOutputDir!!)
        let triage = TriageBuilder(runId, timestamp, gscVersion, app.Id)
        return StageExecutionContext(app, this.options, gsc, projectOutputDir, artifactDir, triage)
    }

    private async func RunAppAsync(
        app CorpusApp,
        gsc GscInvoker,
        gscVersion string?,
        runId string,
        timestamp string,
        runDir string,
        priorHistory IReadOnlyDictionary[string, List[TriageRetryEntry]],
        cancellationToken CancellationToken
    ) AppResult {
        let context = this.CreateAppContext(app, gsc, gscVersion, runId, timestamp, runDir, out var artifactDir)
        let appResult = await this.RunStagesAsync(app, context, artifactDir, runDir, priorHistory, cancellationToken)
            .ConfigureAwait(false)
        if this.options.OutputLayout == MigrationOutputLayout.Repository && !string.IsNullOrWhiteSpace(
            this.options.OutputRoot
        ) {
            // Issue #3668: hand the translate-derived state of this app to any
            // later `cs2gs validate` shard over the same migrated tree.
            let translated = appResult.Stages.Any(
                (s StageResult) -> s.Stage == TriageSerialization.StageName(MigrationStageKind.Translate) &&
                    s.Status == "passed"
            )
            ValidationManifest.Write(
                ValidationManifest.Capture(context, translated, this.options.OutputRoot),
                artifactDir
            )
        }
        return appResult
    }

    private async func RunStagesAsync(
        app CorpusApp,
        context StageExecutionContext,
        artifactDir string,
        runDir string,
        priorHistory IReadOnlyDictionary[string, List[TriageRetryEntry]],
        cancellationToken CancellationToken
    ) AppResult {
        let appResult = AppResult{AppId: app.Id, Succeeded: true}
        var shortCircuited = false
        for stage in this.Stages {
            let stageName = TriageSerialization.StageName(stage.Kind)
            if shortCircuited {
                appResult.Stages.Add(StageResult{Stage: stageName, Status: "skipped", ArtifactCount: 0})
                continue
            }
            // ProcessRunner captures child output for diagnostics. Emit the
            // outer boundary so CI still identifies the active app and stage.
            let stageTimer = Stopwatch.StartNew()
            Console.WriteLine("cs2gs: ${app.Id}: $stageName started.")
            var outcome StageOutcome
            try {
                outcome = await stage.ExecuteAsync(context, cancellationToken).ConfigureAwait(false)
            } catch (OperationCanceledException) {
                rethrow
            } catch (ex Exception) {
                // Issue #3804: a stage crash is a cs2gs defect, and the ONLY
                // record of where it happened is the stack. The artifact keeps
                // the message; the log keeps the frames, so a gate run's log is
                // enough to start a diagnosis from.
                Console.Error.WriteLine("cs2gs: $stageName stage crashed for ${app.Id}:")
                Console.Error.WriteLine(ex)
                outcome = StageOutcome.Failed([]TriageArtifact{StageCrashArtifact(context.Triage, stage.Kind, ex)})
            }
            Console.WriteLine(
                "cs2gs: ${app.Id}: $stageName ${outcome.Status.ToString().ToLowerInvariant()} in " +
                    "${stageTimer.Elapsed.TotalSeconds.ToString("F1", CultureInfo.InvariantCulture)}s."
            )
            if outcome.Status == StageStatus.Passed {
                appResult.Stages.Add(StageResult{Stage: stageName, Status: "passed", ArtifactCount: 0})
                continue
            }
            if outcome.Status == StageStatus.Skipped {
                // "Not verified" (issue #1749): a genuinely-unavailable
                // dependency (no locally-built SDK, a translation step not
                // implemented yet) is neither a pass nor a failure. It must not
                // render as green, so it gets its own status rather than
                // StageStatus.Passed, but it also does not fail the app or
                // short-circuit later stages.
                appResult.Stages.Add(StageResult{Stage: stageName, Status: "skipped", ArtifactCount: 0})
                continue
            }
            let written = this.WriteArtifacts(outcome.Artifacts, artifactDir, runDir, priorHistory, appResult)
            appResult.Stages.Add(StageResult{Stage: stageName, Status: "failed", ArtifactCount: written.Count})
            appResult.Succeeded = false
            appResult.FailureCategory = written.FirstOrDefault()?.Category
            for artifact in written {
                appResult.Fingerprints.Add(artifact.Fingerprint)
            }
            shortCircuited = true
        }
        // Issue #3885: carry the test-parity allow-list verdict into the run
        // record, PASS or FAIL. The gate summary reads it back so an app that
        // is green only because of the allow-list still names the failures it
        // was excused, and a stale entry is visible without reading a log.
        appResult.AllowedTestFailures.AddRange(context.AllowedTestFailures)
        appResult.StaleAllowListEntries.AddRange(context.StaleTestAllowListEntries)
        appResult.TestNameParity = context.TestNameParity
        if appResult.Succeeded && appResult.Stages.Any((s StageResult) -> s.Status == "skipped") {
            // No stage failed, but at least one was genuinely unverified
            // (issue #1831): don't let that roll up as green.
            appResult.Unverified = true
        }
        return appResult
    }

    private func StageCrashArtifact(triage TriageBuilder, stage MigrationStageKind, ex Exception) TriageArtifact {
        // A stage throwing (e.g. project load failure) is itself a captured
        // gap. Fingerprinted via TriageBuilder.StageCrash (issue #1750) on the
        // exception's runtime type rather than its raw Message, which
        // routinely embeds run-scoped absolute paths that would otherwise
        // fingerprint the same recurring crash differently every run/machine.
        //
        // Issue #3804: the category is PipelineCrash whatever the stage. A
        // crash is a defect in the MIGRATION TOOL; filing it as the stage's
        // own failure category made a translator IndexOutOfRangeException
        // arrive as `translation-unsupported`, i.e. as a property of the C#
        // being migrated, and it was triaged accordingly (which is to say, not
        // at all). The diagnostic id still names the stage, so the two are
        // still distinguishable at a glance.
        let diagnosticId = switch stage {
            case MigrationStageKind.Compile: "GS9999"
            case MigrationStageKind.IlVerify: "IlVerifyError"
            case MigrationStageKind.TestParity: "STDOUT-MISMATCH"
            default: "PipelineException"
        }
        // The wrapper (issue #3804) exists only to name the file; triage sees
        // the exception that was actually thrown, so messages and fingerprints
        // are unchanged by its presence.
        let csFile string? = (ex as TranslationCrashException)?.SourceFilePath
        let crash Exception? = if ex is TranslationCrashException wrapped {
            wrapped.InnerException
        } else {
            ex
        }
        return triage.StageCrash(stage, TriageCategory.PipelineCrash, diagnosticId, crash, csFile)
    }

    private func WriteArtifacts(
        artifacts IReadOnlyList[TriageArtifact],
        appRunDir string,
        runDir string,
        priorHistory IReadOnlyDictionary[string, List[TriageRetryEntry]],
        appResult AppResult
    ) IReadOnlyList[TriageArtifact] {
        let written = List[TriageArtifact]()
        let seen = HashSet[string](StringComparer.Ordinal)
        for artifact in artifacts {
            // Dedup within an app: one file per distinct fingerprint.
            if !seen.Add(artifact.Fingerprint) {
                continue
            }
            if priorHistory.TryGetValue(artifact.Fingerprint, out var history) {
                artifact.RetryHistory.AddRange(history)
            }
            let fileName = artifact.Stage + "-" + FingerprintShort(artifact.Fingerprint) + ".json"
            let artifactPath = Path.Combine(appRunDir, fileName)
            File.WriteAllText(artifactPath, JsonSerializer.Serialize(artifact, TriageSerialization.Options))
            let relative = Path.GetRelativePath(runDir, artifactPath).Replace('\\', '/')
            appResult.Artifacts.Add(relative)
            written.Add(artifact)
        }
        return written
    }

    shared {
        /// Gets the default ordered stage list (stages 1–4:
        /// (cref:TranslateStage) → (cref:CompileStage) →
        /// (cref:IlVerifyStage) → (cref:TestParityStage)).
        /// @returns The default ordered stages.
        func DefaultStages() IReadOnlyList[IMigrationStage] -> []IMigrationStage{
            TranslateStage(),
            CompileStage(),
            IlVerifyStage(),
            TestParityStage()
        }

        /// The default stages up to and including [`last`](paramref) (issue #4853).
        /// @param last The last stage to run.
        /// @returns The ordered stage prefix.
        func StagesThrough(last MigrationStageKind) IReadOnlyList[IMigrationStage] -> DefaultStages().Where(
            (stage IMigrationStage) -> stage.Kind <= last
        )
            .ToList()

        /// Sanitizes a corpus app id into a filesystem-safe directory segment
        /// (`corpus/L1-Console` → `corpus_L1-Console`).
        /// @param id The corpus app id.
        /// @returns The sanitized segment.
        func SanitizeAppId(id string) string -> id.Replace('/', '_').Replace('\\', '_')

        /// The artifact directory name for one app under a run directory. In
        /// repository layout it is suffixed with a hash of the app id so two
        /// projects with the same sanitized id cannot collide. Deterministic from
        /// the app id alone, so a `validate` shard can locate the manifest
        /// written by the whole-repository translate pass (issue #3668).
        /// @param appId The corpus app id.
        /// @param layout The migration output layout.
        /// @returns The artifact directory name.
        func ArtifactDirectoryName(
            appId string,
            layout MigrationOutputLayout
        ) string -> if layout == MigrationOutputLayout
            .Repository {
            SanitizeAppId(appId) +
                "-" +
                Convert
                .ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(appId)))
                .Substring(0, 8)
                .ToLowerInvariant()
        } else {
            SanitizeAppId(appId)
        }

        /// Builds the source-project to mirrored-project map shared by migration
        /// and validation. Passthrough projects retain their `.csproj`
        /// extension; translated apps map to `.gsproj`.
        /// @param apps The translated app set.
        /// @param passthroughProjectPaths Absolute C# project paths preserved without translation.
        /// @param sourceRoot The original repository root.
        /// @param destinationRoot The migrated repository root.
        /// @param runDir The diagnostic-layout run directory.
        /// @param repositoryLayout Whether repository mirroring is active.
        /// @returns The canonical project path map.
        internal func BuildGeneratedProjectPaths(
            apps IReadOnlyList[CorpusApp],
            passthroughProjectPaths IReadOnlyCollection[string]?,
            sourceRoot string?,
            destinationRoot string?,
            runDir string,
            repositoryLayout bool
        ) IReadOnlyDictionary[string, string] {
            let paths = apps.ToDictionary(
                func (app CorpusApp) string {
                    return Path.GetFullPath(app.ProjectPath)
                },
                (app CorpusApp) -> if repositoryLayout {
                    Path.Combine(
                        destinationRoot!!,
                        Path.ChangeExtension(
                            app.RelativeProjectPath ?? Path.GetRelativePath(sourceRoot!!, app.ProjectPath),
                            ".gsproj"
                        )
                    )
                } else {
                    Path.Combine(
                        runDir,
                        SanitizeAppId(app.Id),
                        Path.GetFileNameWithoutExtension(app.ProjectPath) + ".gsproj"
                    )
                },
                StringComparer.OrdinalIgnoreCase
            )
            if repositoryLayout && passthroughProjectPaths != nil {
                for passthroughProjectPath in passthroughProjectPaths {
                    let fullPath = Path.GetFullPath(passthroughProjectPath)
                    paths[fullPath] = Path.Combine(destinationRoot!!, Path.GetRelativePath(sourceRoot!!, fullPath))
                }
            }
            return paths
        }

        private func CompileSourcePaths(project LoadedCSharpProject) IReadOnlyList[string] -> project
            .Documents
            .Select((document LoadedDocument) -> document.FilePath)
            .ToList()

        private func NewRunId(utc DateTime) string {
            let stamp = utc.ToString("yyyy-MM-ddTHH-mm-ssZ", CultureInfo.InvariantCulture)
            let random = RandomNumberGenerator.GetBytes(3)
            return stamp + "_" + Convert.ToHexString(random).ToLowerInvariant()
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

        private func LoadPriorRetryEntries(outputRoot string, currentRunId string) IReadOnlyDictionary[
            string,
            List[TriageRetryEntry]
        ] {
            let map_ = Dictionary[string, List[TriageRetryEntry]](StringComparer.Ordinal)
            if !Directory.Exists(outputRoot) {
                return map_
            }
            for priorRunDir in Directory
                .EnumerateDirectories(outputRoot)
                .Where((d string) -> !string.Equals(DirectoryInfo(d).Name, currentRunId, StringComparison.Ordinal))
                .OrderBy((d string) -> DirectoryInfo(d).Name, StringComparer.Ordinal) {
                // Retry-entry artifacts are written by WriteArtifacts() (below) at
                // exactly one location: <runDir>/<sanitizedAppId>/<stage>-<hash>.json
                // (top-level files directly under each app's run directory; see
                // WriteArtifacts). A recursive "*.json" scan of priorRunDir also
                // walks into stage-4 (test-parity) scaffolds such as
                // <appDir>/test-parity/<Lib>/obj/, whose NuGet-restore JSON
                // (project.assets.json, *.nuget.*.json, MSBuild caches) can be
                // several MB each and grows with every prior run — making this
                // loop cost quadratic over the lifetime of an output root
                // (issue #1751). Enumerate only the app directories directly
                // under priorRunDir, and only the top-level files in each,
                // matching the writer's layout exactly instead of descending into
                // build artifacts.
                for appDir in Directory.EnumerateDirectories(priorRunDir) {
                    for file in Directory.EnumerateFiles(appDir, "*.json", SearchOption.TopDirectoryOnly) {
                        let prior TriageArtifact? = TryReadArtifact(file)
                        if prior?.Fingerprint == nil {
                            continue
                        }
                        if !map_.TryGetValue(prior!!.Fingerprint, out var entries) {
                            entries = List[TriageRetryEntry]()
                            map_[prior!!.Fingerprint] = entries
                        }
                        if entries.All(
                            (e TriageRetryEntry) -> !string.Equals(e.RunId, prior!!.RunId, StringComparison.Ordinal)
                        ) {
                            entries.Add(
                                TriageRetryEntry{RunId: prior!!.RunId, GscVersion: prior!!.GscVersion, Result: "fail"}
                            )
                        }
                    }
                }
            }
            return map_
        }

        private func TryReadArtifact(path string) TriageArtifact? {
            try {
                return JsonSerializer.Deserialize[TriageArtifact](File.ReadAllText(path), TriageSerialization.Options)
            } catch (JsonException) {
                return nil
            } catch (IOException) {
                return nil
            }
        }
    }
}

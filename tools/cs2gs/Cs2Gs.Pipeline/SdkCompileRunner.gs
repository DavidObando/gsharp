// <copyright file="SdkCompileRunner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Text.RegularExpressions
import System.Runtime.InteropServices
import System.Xml.Linq

/// Default stage-2 compile path (issue #2261): instead of invoking `gsc`
/// directly, builds the emitted G# with `dotnet build` against the
/// locally-built `Gsharp.NET.Sdk`. The SDK's gsgen MSBuild targets run the
/// real Roslyn source generators (e.g. CommunityToolkit.Mvvm's
/// `[ObservableProperty]`/`[RelayCommand]`, `[LoggerMessage]`)
/// against the referenced NuGet packages the way a real MSBuild build of the
/// original C# project would, which the direct-gsc path — a bare
/// `MetadataLoadContext` over an explicit reference/analyzer list — does
/// not reproduce. This is the dominant remaining Oahu-migration blocker.
/// The gsc-direct path remains available when
/// (cref:PipelineOptions.CompileViaSdk) is explicitly disabled.
class SdkCompileRunner {
    /// Transforms and builds a mirrored project while keeping all build
    /// products and logs outside the migrated repository.
    /// @param sourceProjectPath The original C# project path.
    /// @param generatedProjectPath The mirrored G# project path.
    /// @param artifactDirectory The external build and log directory.
    /// @param config The build configuration.
    /// @param generatedProjectPaths The complete source-to-generated project map.
    /// @param isAnalyzerTestProject The translate-stage detector's analyzer-test-project verdict.
    /// @param sdkMoniker The run's pinned `Sdk` attribute value
    /// ((cref:PipelineOptions.RepositorySdkMoniker)),
    /// resolved once per run so every project in the mirror builds with the
    /// same pin; `null` when no SDK package could be resolved.
    /// @param analyzerVerifierPackageVersion The run's resolved verifier package version
    /// ((cref:PipelineOptions.RepositoryAnalyzerVerifierPackageVersion)).
    /// @param warningsNotAsErrors Issue #3782: diagnostic ids to keep at warning severity for this build
    /// despite the mirror's `TreatWarningsAsErrors`. The redundant-`!!`
    /// polish loop passes `GS0536` so one build surveys the whole project
    /// graph; `null` is the gate's own strict compile.
    /// @returns The SDK compile result.
    func CompileMirroredProject(
        sourceProjectPath string,
        generatedProjectPath string,
        artifactDirectory string,
        config string,
        generatedProjectPaths IReadOnlyDictionary[string, string]?,
        isAnalyzerTestProject bool,
        sdkMoniker string?,
        analyzerVerifierPackageVersion string?,
        warningsNotAsErrors string? = nil
    ) SdkCompileResult {
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if sdkMoniker == nil {
            return SdkCompileResult.Unavailable(
                "No locally-built Gsharp.NET.Sdk nupkg was found under out/bin/<Config>/nupkgs/ or .nugs/."
            )
        }
        // Issue #3780: an analyzer test project's PackageReference to the
        // verifier needs a concrete, locally-resolvable version.
        if isAnalyzerTestProject {
            if analyzerVerifierPackageVersion == nil {
                return SdkCompileResult.Unavailable(
                    "No locally-built " +
                        AnalyzerTestingPackageId +
                        " nupkg was found under out/bin/<Config>/nupkgs/ or .nugs/."
                )
            }
        }
        let projectDirectory string? = Path.GetDirectoryName(Path.GetFullPath(generatedProjectPath))
        Directory.CreateDirectory(projectDirectory!!)
        Directory.CreateDirectory(artifactDirectory)
        GsharpTestProjectRunner.WriteIsolationBoundary(artifactDirectory)
        WriteLocalNugetConfig(artifactDirectory, repoRoot)
        let project = GSharpProjectTransformer.Transform(
            sourceProjectPath,
            projectDirectory,
            sdkMoniker,
            generatedProjectPaths,
            isAnalyzerTestProject,
            analyzerVerifierPackageVersion
        )
        project.Save(generatedProjectPath, SaveOptions.DisableFormatting)
        let projectNugetConfig = Directory.EnumerateFiles(projectDirectory!!).FirstOrDefault(
            (path string) -> Path.GetFileName(path).Equals("nuget.config", StringComparison.OrdinalIgnoreCase)
        ) ??
            Path.Combine(projectDirectory!!, "nuget.config")
        let originalNugetConfig[]?uint8 = if File.Exists(projectNugetConfig) {
            File.ReadAllBytes(projectNugetConfig)
        } else {
            default([]?uint8)
        }
        WriteLocalNugetConfigFile(projectNugetConfig, repoRoot)
        var temporaryBuildProps IReadOnlyList[(Path string, Original[]?uint8)] = Array.Empty[
            (Path string, Original[]uint8)
        ]()
        try {
            temporaryBuildProps = PrepareTemporaryBuildProps(generatedProjectPaths!!.Values)
            let args = BuildMirroredBuildArguments(
                generatedProjectPath,
                artifactDirectory,
                config,
                projectNugetConfig,
                warningsNotAsErrors
            )
            let result = ProcessRunner.Run(
                "dotnet",
                args,
                projectDirectory,
                MirroredBuildTimeout,
                IsolatedNugetEnvironment(artifactDirectory)
            )
            File.WriteAllText(Path.Combine(artifactDirectory, "sdk.build.log"), result.Output ?? string.Empty)
            var diagnostics = GscInvoker.ParseDiagnostics(result.Output)
            if result.ExitCode != 0 && !diagnostics.Any((d GscDiagnostic) -> d.IsError) {
                // Issue #3634: surface MSBuild-relayed GSxxxx errors (.targets-
                // or gsgen-anchored lines the source-anchored parser misses)
                // instead of letting the caller synthesize an opaque GS9999.
                // Issue #3672: when the build failed without any GSxxxx line at
                // all — an MSBuild/NuGet/csc-level failure such as MSB3202 —
                // relay THAT verbatim for the same reason.
                var relayed = ParseRelayedGsErrors(result.Output)
                if relayed.Count == 0 {
                    relayed = ParseRelayedBuildErrors(result.Output)
                }
                diagnostics = diagnostics.Concat(relayed).ToList()
            }
            let assemblyPath string? = if result.ExitCode == 0 {
                ResolveTargetPath(generatedProjectPath, projectDirectory, config, artifactDirectory)
            } else {
                default(string?)
            }
            if result.ExitCode == 0 && (string.IsNullOrEmpty(assemblyPath) || !File.Exists(assemblyPath)) {
                diagnostics = diagnostics.Append(
                    GscDiagnostic(
                        "GS9999",
                        "The mirrored project built successfully but its evaluated TargetPath could not be resolved.",
                        "error",
                        Path.GetFileName(generatedProjectPath),
                        1,
                        1
                    )
                )
                    .ToList()
            }
            return SdkCompileResult.Completed(result.ExitCode, result.Output, diagnostics, assemblyPath)
        } finally {
            RestoreTemporaryBuildProps(temporaryBuildProps)
            if originalNugetConfig == nil {
                File.Delete(projectNugetConfig)
            } else {
                File.WriteAllBytes(projectNugetConfig, originalNugetConfig)
            }
        }
    }

    /// Builds the supplied G# files via `dotnet build` against the
    /// locally-built `Gsharp.NET.Sdk`.
    /// @param appRunDir The per-app output directory to scaffold the build project under.
    /// @param projectName The source project name to preserve for the generated `.gsproj` and assembly.
    /// @param gsFilePaths The absolute paths of the emitted G# files to compile, in compile order.
    /// @param target The output kind (exe or library).
    /// @param referencePaths The same reference set the gsc-direct path would pass via `/reference:`
    /// (app sibling assemblies, the shared framework, and external NuGet package
    /// assemblies). Reconstructed here into `PackageReference`/`Reference`
    /// MSBuild items instead.
    /// @param analyzerPaths The analyzer/generator assembly paths (issue #2215).
    /// @param additionalFiles The source generator inputs, including AXAML item metadata (issue #2223).
    /// @param rootNamespace The root namespace to set on the project, or `null`.
    /// @param config The build configuration (e.g. `Release`).
    /// @param declaredPackageReferences The source project's declared build/dev-only `PackageReference`s
    /// (issue #2267) — e.g. a version-bumped `Nerdbank.GitVersioning` — to
    /// re-declare in the isolated gsproj even though they contribute no
    /// compile-time reference DLL for (cref:PartitionReferences) to
    /// recover. May be `null` or empty.
    /// @param packageReferences The source project's declared PackageReference items.
    /// @param projectReferences The source project's declared ProjectReference items.
    /// @param generatedProjectPaths The source-to-generated project mapping.
    /// @param usesCentralPackageManagement Whether the generated app's copied `Directory.Packages.props`
    /// actually enables NuGet Central Package Management (issue #2319). When
    /// `true`, any `PackageReference` this method
    /// synthesizes (e.g. [`declaredPackageReferences`](paramref)) omits
    /// `Version=` — CPM's own `PackageVersion` items supply it, and
    /// NuGet's restore fails (NU1008) if both are present.
    /// @param assemblyName The source project's assembly name.
    /// @param warningsNotAsErrors Issue #3782: diagnostic ids to keep at warning severity for this build
    /// despite `TreatWarningsAsErrors` — the redundant-`!!` polish
    /// loop's survey mode. `null` is the strict compile.
    /// @returns The compile result, or an unavailable result when no local SDK nupkg can be found.
    func Compile(
        appRunDir string,
        projectName string,
        gsFilePaths IReadOnlyList[string],
        target TargetKind,
        referencePaths IReadOnlyList[string],
        analyzerPaths IReadOnlyList[string],
        additionalFiles IReadOnlyList[string],
        rootNamespace string,
        config string,
        declaredPackageReferences IReadOnlyList[DeclaredPackageReference]? = nil,
        packageReferences IReadOnlyList[DeclaredProjectItem]? = nil,
        projectReferences IReadOnlyList[DeclaredProjectItem]? = nil,
        generatedProjectPaths IReadOnlyDictionary[string, string]? = nil,
        usesCentralPackageManagement bool = false,
        assemblyName string? = nil,
        warningsNotAsErrors string? = nil
    ) SdkCompileResult {
        if string.IsNullOrEmpty(appRunDir) {
            throw ArgumentException("An app run directory is required.", "appRunDir")
        }
        if string.IsNullOrWhiteSpace(projectName) {
            throw ArgumentException("A project name is required.", "projectName")
        }
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        let sdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot, config) ??
            ResolveFallbackSdkPackageFromLocalFeed(repoRoot)
        if sdk == nil || sdk!!.NupkgPath == nil {
            return SdkCompileResult.Unavailable(
                "No locally-built Gsharp.NET.Sdk nupkg was found under out/bin/<Config>/nupkgs/ or .nugs/."
            )
        }
        GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, sdk.NupkgPath)
        Directory.CreateDirectory(appRunDir)
        GsharpTestProjectRunner.WriteIsolationBoundary(appRunDir)
        WriteLocalNugetConfig(appRunDir, repoRoot)
        let nugetPackagesRoot string? = ResolveNugetPackagesRoot()
        let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
        var (packages, references) = PartitionReferences(
            referencePaths ?? Array.Empty[string](),
            nugetPackagesRoot,
            runtimeDir
        )
        let hasDeclaredPackageReferences = ApplyDeclaredPackageReferencePolicy(packages, packageReferences)
        if projectReferences?.Any((item DeclaredProjectItem) -> !string.IsNullOrEmpty(item.SourceInclude)) == true {
            references = references.Where((path string) -> !IsRepresentedByProjectReference(path, projectReferences))
                .ToList()
        }
        let packageIndex = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase)
        for var i = 0; i < packages.Count; i++ {
            packageIndex[packages[i].Id] = i
        }
        let analyzerReferences = List[string]()
        for analyzerPath in analyzerPaths ?? Array.Empty[string]() {
            if string.IsNullOrWhiteSpace(analyzerPath) {
                continue
            }
            let owningPackage = TryParsePackageFromPath(analyzerPath, nugetPackagesRoot)
            if owningPackage != nil {
                // The PackageReference contributes its analyzer assets. Adding
                // the same DLL explicitly would run generators twice.
                if !hasDeclaredPackageReferences {
                    AddOrUpgradePackage(packages, packageIndex, owningPackage.Id, owningPackage.Version)
                }
                continue
            }
            analyzerReferences.Add(Path.GetFullPath(analyzerPath))
        }
        // Issue #2267: a declared build/dev-only package (nbgv) that also
        // resolved a compile-time DLL is already covered by `packages` above;
        // only the ones DLL reconstruction could never see need to be added
        // here, carrying the PrivateAssets/IncludeAssets metadata `packages`
        // has no room for.
        let declaredOnlyPackages = List[DeclaredPackageReference]()
        let declaredPackageIds = HashSet[string](
            (packageReferences ?? Array.Empty[DeclaredProjectItem]()).Select(
                (item DeclaredProjectItem) -> item.Element.Attribute(XName?("Include")!!)?.Value
            )
                .Where((id string) -> !string.IsNullOrEmpty(id)),
            StringComparer.OrdinalIgnoreCase
        )
        for declared in declaredPackageReferences ?? Array.Empty[DeclaredPackageReference]() {
            if declared == nil || string.IsNullOrWhiteSpace(declared.Id) || packageIndex.ContainsKey(declared.Id) ||
                declaredPackageIds.Contains(declared.Id) {
                continue
            }
            declaredOnlyPackages.Add(declared)
        }
        let projectPath = Path.Combine(appRunDir, projectName + ".gsproj")
        let projectSources IReadOnlyList[string] = (gsFilePaths ?? Array.Empty[string]()).Select(
            (path string) -> Path.GetRelativePath(appRunDir, path)
        )
            .ToList()
        let explicitAdditionalFiles IReadOnlyList[string] = (additionalFiles ?? Array.Empty[string]()).Where(
            (spec string) -> RequiresExplicitProjectItem(appRunDir, spec)
        )
            .ToList()
        let rewrittenProjectReferences = DeclaredProjectItems.RewriteProjectReferences(
            projectReferences,
            appRunDir,
            generatedProjectPaths
        )
        let projectXml = BuildProjectXml(
            sdk.Version,
            target,
            rootNamespace,
            projectSources,
            packages,
            references,
            analyzerReferences,
            declaredOnlyPackages,
            explicitAdditionalFiles,
            packageReferences,
            rewrittenProjectReferences,
            usesCentralPackageManagement,
            assemblyName
        )
        File.WriteAllText(projectPath, projectXml)
        let args = List[string]{"build", projectPath, "-c", config ?? "Release"}
        args.Add("-p:RestorePackagesPath=" + Path.Combine(appRunDir, ".nuget-packages"))
        if !string.IsNullOrEmpty(warningsNotAsErrors) {
            args.Add("-p:WarningsNotAsErrors=" + warningsNotAsErrors)
        }
        let repoNugetConfig = Path.Combine(repoRoot!!, "nuget.config")
        if File.Exists(repoNugetConfig) {
            // MSBuild has no `--configfile` switch (that is a `dotnet restore`/
            // `dotnet nuget` only switch, and fails hard with MSB1001 under
            // `dotnet build`); the MSBuild-property form works for
            // restore/build alike (mirrors GsharpTestProjectRunner.Run).
            args.Add("-p:RestoreConfigFile=" + repoNugetConfig)
        }
        let result = ProcessRunner.Run(
            "dotnet",
            args,
            appRunDir,
            TimeSpan.FromMinutes(10),
            IsolatedNugetEnvironment(appRunDir)
        )
        File.WriteAllText(Path.Combine(appRunDir, "sdk.build.log"), result.Output ?? string.Empty)
        var diagnostics = GscInvoker.ParseDiagnostics(result.Output)
        if result.ExitCode != 0 && diagnostics.Count((d GscDiagnostic) -> d.IsError) == 0 {
            // Issue #3634: before synthesizing an opaque fallback, surface any
            // MSBuild-relayed GSxxxx errors (.targets- or gsgen-anchored) that
            // the source-anchored parser cannot see.
            let relayed = ParseRelayedGsErrors(result.Output)
            if relayed.Count > 0 {
                diagnostics = diagnostics.Concat(relayed).ToList()
            } else {
                let synthetic GscDiagnostic? = SynthesizeFallbackDiagnostic(result, gsFilePaths)
                if synthetic != nil {
                    diagnostics = diagnostics.Append(synthetic).ToList()
                }
            }
        }
        let assemblyPath string? = FindEmittedAssembly(appRunDir, projectName, config, assemblyName)
        if result.ExitCode == 0 && string.IsNullOrEmpty(assemblyPath) {
            let expectedName string? = if string.IsNullOrEmpty(assemblyName) {
                projectName
            } else {
                assemblyName
            }
            diagnostics = diagnostics.Append(
                GscDiagnostic(
                    "GS9999",
                    "Expected output assembly '$expectedName.dll' was not found after a successful SDK build.",
                    "error",
                    if gsFilePaths != nil && gsFilePaths.Count > 0 {
                        Path.GetFileName(gsFilePaths[0])
                    } else {
                        "unknown"
                    },
                    1,
                    1
                )
            )
                .ToList()
        }
        return SdkCompileResult.Completed(result.ExitCode, result.Output, diagnostics, assemblyPath)
    }

    shared {
        /// Issue #4498: the wall-clock budget for a mirrored `dotnet build`.
        /// It is separate from (cref:MirroredTestRunTimeout), which it used to
        /// share. One build invocation compiles the app AND its whole project-reference
        /// closure (Core.Tests builds Core, the analyzers and the runtime libraries
        /// first), so a healthy hot-core test app already takes 6 to 8+ minutes on a
        /// nightly runner, and ordinary runner variance pushed it past ten (nightly
        /// 36236554862). Twenty minutes still fails a genuinely hung build promptly.
        internal let MirroredBuildTimeout TimeSpan = TimeSpan.FromMinutes(20)

        /// Issue #3931: the FLOOR of the budget for a mirrored `dotnet test` run
        /// (see (cref:MirroredTestRunTimeoutFor)). Named (rather than
        /// inline) so the parity stage can report the exact budget a killed run
        /// exceeded instead of describing a nameless timeout.
        ///
        /// Issue #3501: this stayed the budget for EVERY app's test run until the
        /// corpus grew suites of a few thousand cases, at which point a single
        /// global constant stopped being a hang detector and became a size limit:
        /// the app was killed for being big, not for being stuck. It survives as
        /// the floor because a small suite that has not finished in ten minutes
        /// really is stuck, and a hang there must still fail promptly.
        internal let MirroredTestRunTimeout TimeSpan = TimeSpan.FromMinutes(10)

        /// Issue #3501: the hard ceiling on a mirrored test budget, whatever the
        /// suite's size says it wants.
        ///
        /// It started as the 90 minutes issue #4045 granted `Compiler.Tests`
        /// by hand. Issue #4633 raised it to 120: nightly 36906270739 measured the
        /// migrated `Compiler.Tests` run at 4,941 s, 91% of 90 minutes, so
        /// ordinary runner variance was enough to turn a healthy suite into a
        /// `LIBRARY-TESTS-TIMED-OUT` with no parity verdict at all. 120
        /// minutes plus that app's ~25 minutes of compile and ILVerify still fits
        /// the 240-minute validation job with room for its shard-mates. The
        /// ceiling matters because a validation shard runs all of its apps under a
        /// single `cs2gs validate` process that writes `shard-run.json`
        /// only at the end (see `build/run-cs2gs-selfmig-validate.sh`), so a
        /// shard that overruns the job's 240-minute limit loses EVERY app's
        /// verdict — the same "no measurement at all" failure this sizing exists to
        /// remove, just one level up. An unbounded per-app budget would trade one
        /// app's missing parity count for a whole shard's.
        internal let MirroredTestRunTimeoutCeiling TimeSpan = TimeSpan.FromMinutes(120)

        /// Issue #3501: seconds of budget granted per `[Fact]` method declared
        /// by the app's C# original.
        ///
        /// Calibrated against measurement, not taste. Two DIFFERENT measurements
        /// feed this constant, and every figure below is labelled with the one it
        /// came from — they were conflated once already, and a calibration record
        /// that mixes them is worse than no record:
        /// - CI — gate run 34232380469 (`cs2gs-selfmig-nightly` on `main`, Release, GitHub-hosted runner). The
        /// MIGRATED `test/Compiler.Tests`, 4,103 declared `[Fact]` methods, completed and reported
        /// `Failed: 79, Passed: 5415, Skipped: 0, Total: 5494`. Its whole validation cost 4,864 s (~81 min), of
        /// which the test run was the dominant share at 3,658 s (~61 min): ~0.9 s per declared `[Fact]` for the
        /// run alone, ~1.2 s once the rest of validation is charged to the same count.
        /// - LOCAL — the C# ORIGINALS timed on a developer machine in Debug, which agree on the shape:
        /// `Cs2Gs.Tests` 2,891 cases in 21 m 57 s (re-measured 2026-09-08) and `Compiler.Tests` 5,234 cases in
        /// 41 min (2026-09-06), ≈ 0.45 s per executed case. These case counts are local Debug numbers for the
        /// ORIGINALS and are NOT the CI run's totals above; the migrated build runs slower, and a declared
        /// count is lower than an executed count because a `[Theory]` expands.
        /// The rate is derived from the CI line alone — 4,103 declared facts over
        /// that run's ~81 minutes — so the executed-case counts are context, not
        /// inputs, and correcting one does not move the constant. 1.5 s/test is
        /// that observed rate with a ~50% margin for runner variance, which is
        /// enough to distinguish "large" from "stuck" without waiting out a real
        /// hang.
        private const MirroredTestRunSecondsPerDeclaredTest float64 = 1.5

        private const SdkPackageId string = "Gsharp.NET.Sdk"

        // Issue #3780: the analyzer-testing package id, kept in sync with the
        // package's own PackageId via GSharpProjectTransformer's constant.
        private const AnalyzerTestingPackageId string = GSharpProjectTransformer.AnalyzerVerifierAssemblyName

        /// Issue #3501: the size-independent part of a mirrored test budget — SDK
        /// host start, VSTest discovery over an assembly with thousands of types,
        /// and first-run JIT. Charged to every scaled budget so
        /// (cref:MirroredTestRunSecondsPerDeclaredTest) prices only the
        /// tests themselves.
        private let MirroredTestRunFixedOverhead TimeSpan = TimeSpan.FromMinutes(5)

        // Matches a generic MSBuild/NuGet/CS error line, e.g.
        // `... : error NU1101: ...` or `... : error CS0246: ...`, used only as a
        // last-resort fallback when no structured GSxxxx diagnostic was parsed.
        private let GenericErrorPattern Regex = Regex(
            ":\\s+error\\s+(?<code>[A-Za-z]+\\d+):\\s*(?<msg>.*)$$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )

        // Matches an MSBuild-relayed GSxxxx error line (issue #3634). Unlike gsc's
        // own four-coordinate `<file>(l,c,el,ec):` shape that
        // GscInvoker.ParseDiagnostics recognizes, MSBuild task/target errors carry
        // a two-coordinate location whose path is not a .gs source at all — e.g.
        // `.../build/Gsharp.NET.Core.Sdk.targets(505,5): error GS9998: ... [App.gsproj]`
        // or `gsgen(1,1): error GS9200: ...` — and may append a `[project]` suffix.
        // The location prefix is optional so a bare `error GSxxxx: message` line
        // still surfaces with a best-effort location.
        private let RelayedGsErrorPattern Regex = Regex(
            "^(?:(?<file>.+?)\\((?<line>\\d+),(?<col>\\d+)(?:,(?<eline>\\d+),(?<ecol>\\d+))?\\)\\s*:\\s*)?" +
                "error\\s+(?<id>GS\\d{4}):\\s*(?<msg>.*)$$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )

        // Issue #3672: the same shape for a build that failed with NO GSxxxx line
        // at all — an MSBuild task/target error (`error MSB3202:`), a restore
        // failure (`error NU1101:`), or a csc error from a C# project still in the
        // graph (`error CS0246:`). Only consulted when the GS scan above found
        // nothing, so a real G# diagnostic always wins.
        // The coordinates are optional here as well as the whole prefix, so the
        // location-free `MSBUILD : error MSB1009: …` shape is recognized too.
        private let RelayedBuildErrorPattern Regex = Regex(
            "^(?:(?<file>.+?)(?:\\((?<line>\\d+),(?<col>\\d+)(?:,(?<eline>\\d+),(?<ecol>\\d+))?\\))?\\s*:\\s*)?" +
                "error\\s+(?<id>[A-Za-z]{2,}\\d{2,}):\\s*(?<msg>.*)$$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        )

        // The well-known NuGet package-asset directories that follow an
        // `{id}/{version}/` pair under a packages cache root (generic detector,
        // not specific to any single package).
        private let KnownAssetDirectories HashSet[string] = HashSet[string](StringComparer.OrdinalIgnoreCase){
            "lib",
            "ref",
            "analyzers",
            "runtimes",
            "build",
            "buildTransitive",
            "contentFiles",
            "tools"
        }

        internal func IsolatedNugetEnvironment(root string) IReadOnlyDictionary[string, string] -> Dictionary[
            string,
            string
        ]{
            ["NUGET_PACKAGES"] = Path.Combine(root, ".nuget-packages"),
            [GsharpTestProjectRunner.SourceRootEnvironmentVariable] = string.Empty
        }

        internal func MirroredTestEnvironment(artifactRoot string, sourceRoot string?) IReadOnlyDictionary[
            string,
            string
        ] {
            if string.IsNullOrWhiteSpace(sourceRoot) {
                throw DirectoryNotFoundException(
                    "Stage 4 requires the original C# source root; " +
                        "${GsharpTestProjectRunner.SourceRootEnvironmentVariable} was not configured."
                )
            }
            let canonicalSourceRoot string? = CanonicalRootPath.Resolve(sourceRoot)
            if !Directory.Exists(canonicalSourceRoot) {
                throw DirectoryNotFoundException("Stage-4 source root does not exist: '$canonicalSourceRoot'.")
            }
            let environment = Dictionary[string, string](IsolatedNugetEnvironment(artifactRoot)){
                [GsharpTestProjectRunner.SourceRootEnvironmentVariable] = canonicalSourceRoot
            }
            return environment
        }

        /// Partitions a flat reference-path list into reconstructed
        /// `PackageReference` ids/versions (for dlls that live under a NuGet
        /// packages cache) and the remaining loose/sibling `Reference` paths.
        /// Shared-framework assemblies (matched by file name against
        /// [`runtimeDir`](paramref)) are dropped entirely — the SDK's own
        /// target framework reference already supplies them. Exposed
        /// `internal` so it is unit-testable without a live NuGet
        /// cache or a real `dotnet build`.
        /// @param referencePaths The flat reference-path list (gsc's `/reference:` set).
        /// @param nugetPackagesRoot The NuGet global-packages folder (`NUGET_PACKAGES` or `~/.nuget/packages`).
        /// @param runtimeDir The shared-framework directory to exclude.
        /// @returns The reconstructed package id/version pairs and the remaining loose reference paths.
        internal func PartitionReferences(
            referencePaths IEnumerable[string],
            nugetPackagesRoot string?,
            runtimeDir string
        )(Packages List[(Id string, Version string)], References List[string]) {
            let packages = List[(Id string, Version string)]()
            let packageIndex = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase)
            let references = List[string]()
            let runtimeFileNames = HashSet[string](StringComparer.OrdinalIgnoreCase)
            if !string.IsNullOrEmpty(runtimeDir) && Directory.Exists(runtimeDir) {
                for file in Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly) {
                    runtimeFileNames.Add(Path.GetFileName(file))
                }
            }
            for path in referencePaths ?? Array.Empty[string]() {
                if string.IsNullOrWhiteSpace(path) {
                    continue
                }
                let package_ = TryParsePackageFromPath(path, nugetPackagesRoot)
                if package_ != nil {
                    AddOrUpgradePackage(packages, packageIndex, package_.Id, package_.Version)
                    continue
                }
                if runtimeFileNames.Contains(Path.GetFileName(path)) {
                    // Shared-framework assembly copy: the SDK's TargetFramework
                    // already supplies these; skip to avoid a double identity.
                    continue
                }
                references.Add(path)
            }
            return (packages, references)
        }

        /// Attempts to parse a NuGet package id/version out of an assembly path
        /// living under a packages cache. Honors [`nugetPackagesRoot`](paramref)
        /// when the path is rooted there, and otherwise falls back to a generic
        /// scan for any `.../packages/{id}/{version}/{asset-dir}/...` shape
        /// (so a differently-configured cache root, e.g. a CI-specific
        /// `NUGET_PACKAGES`, is still recognized).
        /// @param path The candidate assembly path.
        /// @param nugetPackagesRoot The known packages root, or `null`.
        /// @returns The parsed id/version pair, or `null` when the path is not a packages-cache path.
        internal func TryParsePackageFromPath(path string, nugetPackagesRoot string?)(Id string, Version string)? {
            if string.IsNullOrEmpty(path) {
                return nil
            }
            let normalized = path.Replace('\\', '/')
            if !string.IsNullOrEmpty(nugetPackagesRoot) {
                let root = nugetPackagesRoot.Replace('\\', '/').TrimEnd('/') + "/"
                if normalized.StartsWith(root, StringComparison.OrdinalIgnoreCase) {
                    let remainder = normalized.Substring(root.Length)
                    let rootedSegments = remainder.Split('/')
                    if rootedSegments.Length >= 2 && !string.IsNullOrEmpty(rootedSegments[0]) && !string.IsNullOrEmpty(
                        rootedSegments[1]
                    ) {
                        return (rootedSegments[0], rootedSegments[1])
                    }
                }
            }
            let segments = normalized.Split('/')
            for var i = 0; i <= segments.Length - 4; i++ {
                if string.Equals(segments[i], "packages", StringComparison.OrdinalIgnoreCase) &&
                    KnownAssetDirectories.Contains(segments[i + 3]) && !string.IsNullOrEmpty(segments[i + 1]) &&
                    !string.IsNullOrEmpty(segments[i + 2]) {
                    return (segments[i + 1], segments[i + 2])
                }
            }
            return nil
        }

        /// Renders the migrated, source-named `.gsproj` XML text: the SDK-project header,
        /// build properties, `@(Compile)` items, `@(PackageReference)`
        /// (both the reconstructed-from-DLL set and the declared build/dev-only set,
        /// issue #2267), `@(Reference)`, and `@(Analyzer)` items. Exposed
        /// `internal` so the package/analyzer item emission is
        /// unit-testable without a live NuGet cache or a real `dotnet build`.
        /// @param sdkVersion The resolved `Gsharp.NET.Sdk` version.
        /// @param target The output kind (exe or library).
        /// @param rootNamespace The root namespace to set on the project, or `null`.
        /// @param gsFilePaths The absolute paths of the emitted G# files to compile, in compile order.
        /// @param packages The `PackageReference` id/version pairs reconstructed from compile-time DLLs.
        /// @param references The remaining loose/sibling `Reference` paths.
        /// @param analyzerReferences The analyzer/generator assembly paths (issue #2215).
        /// @param declaredPackageReferences The source project's declared build/dev-only `PackageReference`s
        /// (issue #2267) to re-declare even though they contributed no compile-time
        /// DLL to [`packages`](paramref).
        /// @param additionalFiles The source generator inputs to emit as project items.
        /// @param packageReferences The declared PackageReference items to preserve.
        /// @param projectReferences The declared ProjectReference items to preserve.
        /// @param usesCentralPackageManagement Whether the generated app's copied `Directory.Packages.props`
        /// actually enables NuGet Central Package Management (issue #2319). When
        /// `true`, every synthesized `PackageReference` below
        /// (both [`packages`](paramref) and [`declaredPackageReferences`](paramref))
        /// omits `Version=`, since CPM requires the version to come exclusively
        /// from a `PackageVersion` item and rejects a project-level
        /// `Version=` attribute outright (NU1008).
        /// @param assemblyName The source project's assembly name.
        /// @returns The full `.gsproj` XML text.
        internal func BuildProjectXml(
            sdkVersion string,
            target TargetKind,
            rootNamespace string,
            gsFilePaths IReadOnlyList[string],
            packages IReadOnlyList[(Id string, Version string)],
            references IReadOnlyList[string],
            analyzerReferences IReadOnlyList[string],
            declaredPackageReferences IReadOnlyList[DeclaredPackageReference]? = nil,
            additionalFiles IReadOnlyList[string]? = nil,
            packageReferences IReadOnlyList[DeclaredProjectItem]? = nil,
            projectReferences IReadOnlyList[DeclaredProjectItem]? = nil,
            usesCentralPackageManagement bool = false,
            assemblyName string? = nil
        ) string {
            var declaredPackageReferences = declaredPackageReferences
            var additionalFiles = additionalFiles
            declaredPackageReferences ??= Array.Empty[DeclaredPackageReference]()
            additionalFiles ??= Array.Empty[string]()
            let outputType = if target == TargetKind.Exe {
                "Exe"
            } else {
                "Library"
            }
            let sb = StringBuilder()
            sb.Append("<Project Sdk=\"").Append(SdkPackageId).Append('/').Append(sdkVersion).Append("\">\n")
            sb.Append('\n')
            sb.Append("  <PropertyGroup>\n")
            sb.Append("    <OutputType>").Append(outputType).Append("</OutputType>\n")
            sb.Append("    <TargetFramework>net10.0</TargetFramework>\n")
            sb.Append("    <Nullable>enable</Nullable>\n")
            sb.Append("    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>\n")
            sb.Append("    <Deterministic>true</Deterministic>\n")
            sb.Append("    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>\n")
            if !string.IsNullOrEmpty(rootNamespace) {
                sb.Append("    <RootNamespace>").Append(rootNamespace).Append("</RootNamespace>\n")
            }
            if !string.IsNullOrEmpty(assemblyName) {
                sb.Append("    <AssemblyName>").Append(assemblyName).Append("</AssemblyName>\n")
            }
            sb.Append("  </PropertyGroup>\n")
            sb.Append('\n')
            sb.Append("  <ItemGroup>\n")
            for gsFile in gsFilePaths {
                sb.Append("    <Compile Include=\"").Append(gsFile).Append("\" />\n")
            }
            sb.Append("  </ItemGroup>\n")
            if packages.Count > 0 || declaredPackageReferences!!.Count > 0 {
                sb.Append('\n')
                sb.Append("  <ItemGroup>\n")
                for (id, version) in packages {
                    sb.Append("    <PackageReference Include=\"").Append(id).Append('"')
                    if !usesCentralPackageManagement {
                        sb.Append(" Version=\"").Append(version).Append('"')
                    }
                    if id.Equals("microsoft.build.framework", StringComparison.OrdinalIgnoreCase) {
                        sb.Append(" ExcludeAssets=\"runtime\"")
                    }
                    sb.Append(" />\n")
                }
                // Issue #2267: build/dev-only packages (e.g. Nerdbank.GitVersioning)
                // that contributed no compile-time DLL and so are absent from
                // `packages` above, re-declared here so their MSBuild source
                // generators still run under `dotnet build`. Issue #2319: under
                // Central Package Management the version comes exclusively from
                // the copied Directory.Packages.props's PackageVersion item — a
                // Version= attribute here as well is rejected by NuGet (NU1008).
                for declared in declaredPackageReferences!! {
                    sb.Append("    <PackageReference Include=\"").Append(declared.Id).Append('"')
                    if !usesCentralPackageManagement {
                        sb.Append(" Version=\"").Append(declared.Version).Append('"')
                    }
                    if !string.IsNullOrEmpty(declared.PrivateAssets) {
                        sb.Append(" PrivateAssets=\"").Append(declared.PrivateAssets).Append('"')
                    }
                    if !string.IsNullOrEmpty(declared.IncludeAssets) {
                        sb.Append(" IncludeAssets=\"").Append(declared.IncludeAssets).Append('"')
                    }
                    sb.Append(" />\n")
                }
                sb.Append("  </ItemGroup>\n")
            }
            AppendDeclaredItems(sb, packageReferences)
            AppendDeclaredItems(sb, projectReferences)
            if references.Count > 0 {
                sb.Append('\n')
                sb.Append("  <ItemGroup>\n")
                for reference in references {
                    sb.Append("    <Reference Include=\"").Append(Path.GetFullPath(reference)).Append("\" />\n")
                }
                sb.Append("  </ItemGroup>\n")
            }
            if analyzerReferences.Count > 0 {
                sb.Append('\n')
                sb.Append("  <ItemGroup>\n")
                for analyzerReference in analyzerReferences {
                    sb.Append("    <Analyzer Include=\"").Append(analyzerReference).Append("\" />\n")
                }
                sb.Append("  </ItemGroup>\n")
            }
            if additionalFiles!!.Count > 0 {
                sb.Append('\n')
                sb.Append("  <ItemGroup>\n")
                for spec in additionalFiles!! {
                    let segments = spec.Split(';', StringSplitOptions.RemoveEmptyEntries)
                    let path = segments[0]
                    let isAvaloniaXaml = segments.Skip(1).Any(
                        (s string) -> string.Equals(
                            s,
                            "SourceItemGroup=AvaloniaXaml",
                            StringComparison.OrdinalIgnoreCase
                        )
                    )
                    let itemName = if isAvaloniaXaml {
                        "AvaloniaXaml"
                    } else {
                        "AdditionalFiles"
                    }
                    sb.Append("    <").Append(itemName).Append(" Include=\"").Append(path).Append("\" />\n")
                }
                sb.Append("  </ItemGroup>\n")
            }
            sb.Append('\n')
            sb.Append("</Project>\n")
            return sb.ToString()
        }

        internal func RequiresExplicitProjectItem(projectDirectory string, spec string) bool {
            if string.IsNullOrEmpty(spec) {
                return false
            }
            let segments = spec.Split(';', StringSplitOptions.RemoveEmptyEntries)
            let isAvaloniaXaml = segments.Skip(1).Any(
                (s string) -> string.Equals(s, "SourceItemGroup=AvaloniaXaml", StringComparison.OrdinalIgnoreCase)
            )
            if !isAvaloniaXaml {
                return true
            }
            let relativePath = Path.GetRelativePath(projectDirectory, segments[0])
            return Path.IsPathRooted(relativePath) || relativePath.Equals("..", StringComparison.Ordinal) ||
                relativePath.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
                relativePath.StartsWith(".." + Path.AltDirectorySeparatorChar, StringComparison.Ordinal)
        }

        internal func ResolveSdkMoniker(config string) string? {
            let version string? = ResolveSdkVersion(config, explicitVersion: nil)
            return if version == nil {
                default(string?)
            } else {
                SdkPin.ProjectSdkAttribute(version, SdkPinLocation.ProjectFile)
            }
        }

        /// Resolves the `Gsharp.NET.Sdk` version a repository migration pins.
        /// With no [`explicitVersion`](paramref) it is the newest locally-built
        /// nupkg (the historical behaviour). With one, that exact version is used
        /// and nothing newer can displace it: a matching local nupkg, if any, is
        /// staged into the `.nugs` feed; otherwise the version must come from
        /// nuget.org (the mirror's generated nuget.config lists only nuget.org and the local .nugs feed), and
        /// restore
        /// fails loudly if it cannot.
        /// @param config The build config to probe (e.g. `Release`).
        /// @param explicitVersion The requested version, or `null`.
        /// @returns The version, or `null` when no local nupkg exists and none was requested.
        internal func ResolveSdkVersion(config string, explicitVersion string?) string? -> ResolvePinnedPackageVersion(
            SdkPackageId,
            config,
            explicitVersion
        )

        /// Resolves the version of a locally-built
        /// `GSharp.CodeAnalysis.Analyzers.Testing` nupkg (issue #3780), for
        /// use as the `Version` of the `PackageReference`
        /// (cref:GSharpProjectTransformer) injects into a migrated analyzer
        /// test project. Mirrors (cref:ResolveSdkMoniker): it also stages
        /// the resolved nupkg into the repo's `.nugs` local feed so restore
        /// can find it without a real NuGet publish.
        /// @param config The build config to probe (e.g. `Release`).
        /// @returns The resolved package version, or `null` when no local nupkg exists.
        internal func ResolveAnalyzerVerifierPackageVersion(
            config string
        ) string? -> ResolveAnalyzerVerifierPackageVersion(config, explicitVersion: nil)

        /// Resolves the analyzer verifier package version. It ships on the same
        /// version train as `Gsharp.NET.Sdk`, so an explicitly pinned SDK
        /// version pins it too (see (cref:ResolveSdkVersion)).
        /// @param config The build config to probe (e.g. `Release`).
        /// @param explicitVersion The pinned SDK version, or `null`.
        /// @returns The package version, or `null` when none is available.
        internal func ResolveAnalyzerVerifierPackageVersion(
            config string,
            explicitVersion string?
        ) string? -> ResolvePinnedPackageVersion(AnalyzerTestingPackageId, config, explicitVersion)

        /// Issue #3501: returns the bounded stage-4 budget for one mirrored test
        /// project, scaled to the amount of work that project actually has to do.
        ///
        /// The budget used to be one global constant, and issue #4045 punched a
        /// single hand-set hole in it for `Compiler.Tests`. Both shapes are
        /// wrong for the same reason: a timeout is supposed to answer "is this run
        /// stuck?", and a constant answers "is this suite bigger than the one I was
        /// sized against?" instead. When it fires on a big-but-healthy suite the
        /// cost is not merely a slow job — the killed run carries no VSTest
        /// summary, so the app produces NO parity count at all and cannot be driven
        /// to green, because nobody can see what is failing. That is what blocked
        /// `tools/cs2gs/Cs2Gs.Tests` (2,579 declared `[Fact]` methods;
        /// its C# ORIGINAL alone runs 2,891 cases in 21 minutes when measured
        /// locally — the migrated run has never reported a count, which is the
        /// point) under a 10-minute budget it could never have met.
        ///
        /// The scale signal is the `[Fact]` count of the app's own C# original
        /// — the number the parity stage already computes and already trusts as the
        /// lower bound on executed cases (issue #3869), so no new measurement,
        /// no new file, and no new way for the two to disagree. Two other available
        /// signals were deliberately NOT used:
        /// `build/selfmig-shard-costs.json` is a per-app WALL TIME republished
        /// by each nightly, so deriving a timeout from it is circular — a killed
        /// run's recorded cost is capped by the very budget being derived, and the
        /// number a hang writes would fund the next hang; and the migrated suite's
        /// own runtime cannot be consulted before the run it is meant to bound.
        /// A count of declared tests, by contrast, is a property of the source: it
        /// moves only when someone writes or deletes a test.
        ///
        /// The result is clamped on both ends. Below
        /// (cref:MirroredTestRunTimeout) nothing changes for the ~50 small
        /// apps in the corpus, so a hang there still fails in ten minutes; above
        /// (cref:MirroredTestRunTimeoutCeiling) the budget stops growing so
        /// no app can take its shard past the CI job limit. The value is rounded up
        /// to whole minutes because it is quoted verbatim in the
        /// `LIBRARY-TESTS-TIMED-OUT` diagnostic (#3931), and a budget printed
        /// to the millisecond reads like a measurement rather than a policy.
        /// @param declaredTestMethods The number of `[Fact]` methods declared by the app's C# original
        /// (`TestParityStage.CountCSharpFactMethods`). Zero — an app whose
        /// sources could not be counted — yields the floor, never something
        /// smaller.
        /// @returns The deterministic, size-derived per-app test budget.
        internal func MirroredTestRunTimeoutFor(declaredTestMethods int32) TimeSpan {
            if declaredTestMethods <= 0 {
                return MirroredTestRunTimeout
            }
            let seconds = MirroredTestRunFixedOverhead.TotalSeconds +
                (float64(declaredTestMethods) * MirroredTestRunSecondsPerDeclaredTest)
            let scaled = TimeSpan.FromMinutes(Math.Ceiling(seconds / 60.0))
            if scaled < MirroredTestRunTimeout {
                return MirroredTestRunTimeout
            }
            return if scaled > MirroredTestRunTimeoutCeiling {
                MirroredTestRunTimeoutCeiling
            } else {
                scaled
            }
        }

        /// Issue #4633: the directory a mirrored test run writes its TRX files to,
        /// derived from the app's artifact directory alone. A multi-targeted
        /// project writes one TRX per framework; the parity stage reads them all.
        /// @param artifactDirectory The app's artifact directory.
        /// @returns The absolute results directory.
        internal func MirroredTestResultsDirectory(artifactDirectory string) string -> Path.Combine(
            Path.GetFullPath(artifactDirectory),
            "test-results"
        )

        internal func TestMirroredProject(
            generatedProjectPath string,
            artifactDirectory string,
            config string,
            generatedProjectPaths IReadOnlyDictionary[string, string]?,
            sourceRoot string?,
            timeout TimeSpan
        ) ProcessRunResult {
            let projectDirectory string? = Path.GetDirectoryName(Path.GetFullPath(generatedProjectPath))
            let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
            let projectNugetConfig = Directory.EnumerateFiles(projectDirectory!!).FirstOrDefault(
                (path string) -> Path.GetFileName(path).Equals("nuget.config", StringComparison.OrdinalIgnoreCase)
            ) ??
                Path.Combine(projectDirectory!!, "nuget.config")
            let originalNugetConfig[]?uint8 = if File.Exists(projectNugetConfig) {
                File.ReadAllBytes(projectNugetConfig)
            } else {
                default([]?uint8)
            }
            WriteLocalNugetConfigFile(projectNugetConfig, repoRoot)
            var temporaryBuildProps IReadOnlyList[(Path string, Original[]?uint8)] = Array.Empty[
                (Path string, Original[]uint8)
            ]()
            try {
                temporaryBuildProps = PrepareTemporaryBuildProps(generatedProjectPaths!!.Values)
                // Issue #4633: a stale TRX from an earlier run in the same artifact
                // directory must never stand in for this run's results. One that
                // cannot be deleted throws here (an app-scoped pipeline crash).
                let resultsDirectory = MirroredTestResultsDirectory(artifactDirectory)
                Directory.CreateDirectory(resultsDirectory)
                for stale in Directory.EnumerateFiles(resultsDirectory, "*.trx") {
                    File.Delete(stale)
                }
                return ProcessRunner.Run(
                    "dotnet",
                    []string{
                        "test",
                        generatedProjectPath,
                        "--no-build",
                        "-c",
                        config ?? "Release",
                        "-p:Cs2GsArtifactRoot=" + artifactDirectory,
                        "--logger",
                        "trx;LogFilePrefix=parity",
                        "--results-directory",
                        resultsDirectory,
                        "--",
                        CSharpTestOracle.RunSettingsArgument
                    },
                    projectDirectory,
                    timeout,
                    MirroredTestEnvironment(artifactDirectory, sourceRoot)
                )
            } finally {
                RestoreTemporaryBuildProps(temporaryBuildProps)
                if originalNugetConfig == nil {
                    File.Delete(projectNugetConfig)
                } else {
                    File.WriteAllBytes(projectNugetConfig, originalNugetConfig)
                }
            }
        }

        internal func PrepareTemporaryBuildProps(generatedProjectPaths IEnumerable[string]) IReadOnlyList[
            (Path string, Original[]?uint8)
        ] {
            let prepared = List[(Path string, Original[]?uint8)]()
            let mirrorRoot string? = ResolveMirrorRoot(generatedProjectPaths)
            try {
                for projectDirectory in generatedProjectPaths.Select(
                    (path string) -> Path.GetDirectoryName(Path.GetFullPath(path))!!
                )
                    .Distinct(StringComparer.OrdinalIgnoreCase) {
                    let propsPath = Path.Combine(projectDirectory, "Directory.Build.props")
                    let original[]?uint8 = if File.Exists(propsPath) {
                        File.ReadAllBytes(propsPath)
                    } else {
                        default([]?uint8)
                    }
                    var document XDocument
                    if original == nil {
                        document = XDocument(XElement(XName?("Project")!!))
                        let inheritedProps string? = FindInheritedBuildProps(projectDirectory)
                        if inheritedProps != nil {
                            document.Root!!.Add(
                                XElement(
                                    XName?("Import")!!,
                                    XAttribute(
                                        XName?("Project")!!,
                                        Path.GetRelativePath(projectDirectory, inheritedProps)
                                    )
                                )
                            )
                        }
                    } else {
                        using let stream = MemoryStream(original)
                        document = XDocument.Load(stream, LoadOptions.PreserveWhitespace)
                    }
                    let ns = document.Root!!.Name.Namespace
                    // Issue #2868: mirror each project's repo-relative directory
                    // under `$(Cs2GsArtifactRoot)/bin`, which then acts as the
                    // migrated repo root. A flat `bin/$(MSBuildProjectName)/`
                    // layout collapses the repo structure, so any test that
                    // locates a sibling project's output by walking up from its own
                    // assembly directory (the standard E2E pattern —
                    // `../../../../../src/App/bin/$(Config)/$(TFM)/app.dll`) can
                    // never resolve it, no matter how correct the translation is.
                    // Keeping everything under `bin/` also preserves the existing
                    // "search `<artifactDir>/bin` recursively" contract.
                    let mirroredDirectory = MirroredProjectDirectory(projectDirectory, mirrorRoot)
                    document.Root!!.Add(
                        XElement(
                            ns + "PropertyGroup",
                            XElement(ns + "BaseOutputPath", "$$(Cs2GsArtifactRoot)/bin/" + mirroredDirectory + "/bin/"),
                            XElement(
                                ns + "BaseIntermediateOutputPath",
                                "$$(Cs2GsArtifactRoot)/obj/" + mirroredDirectory + "/obj/"
                            ),
                            XElement(
                                ns + "MSBuildProjectExtensionsPath",
                                "$$(Cs2GsArtifactRoot)/obj/" + mirroredDirectory + "/obj/"
                            )
                        )
                    )
                    document.Save(propsPath, SaveOptions.DisableFormatting)
                    prepared.Add((propsPath, original))
                }
            } catch {
                RestoreTemporaryBuildProps(prepared)
                rethrow
            }
            return prepared
        }

        /// Issue #2868: resolves the migrated repo root shared by every mirrored
        /// project — the longest common directory prefix of the complete
        /// source-to-generated project map, which by construction is the root the
        /// mirror was written under. Each project's path relative to it is the
        /// repo-relative directory reproduced inside the artifact tree. With a
        /// single project there is no sibling to resolve, so its own parent
        /// directory serves as the root.
        /// @param generatedProjectPaths The complete generated project path set.
        /// @returns The mirrored repo root, or `null` when it cannot be determined.
        internal func ResolveMirrorRoot(generatedProjectPaths IEnumerable[string]) string? {
            // Issue #4612: GetDirectoryName returns null for a root path. It maps
            // to the empty string the next filter already drops; a null lambda
            // result would throw in the migrated G#.
            let directories = (generatedProjectPaths ?? Enumerable.Empty[string]())
                .Where((path string) -> !string.IsNullOrEmpty(path))
                .Select((path string) -> Path.GetDirectoryName(Path.GetFullPath(path)) ?? string.Empty)
                .Where((directory string) -> !string.IsNullOrEmpty(directory))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList()
            if directories.Count == 0 {
                return nil
            }
            if directories.Count == 1 {
                return Path.GetDirectoryName(directories[0])
            }
            let candidate = directories[0].Split(Path.DirectorySeparatorChar)
            var shared = candidate.Length
            for directory in directories.Skip(1) {
                let parts = directory.Split(Path.DirectorySeparatorChar)
                var index = 0
                while index < shared && index < parts.Length && string.Equals(
                    candidate[index],
                    parts[index],
                    StringComparison.OrdinalIgnoreCase
                ) {
                    index++
                }
                shared = index
            }
            return if shared == 0 {
                default(string?)
            } else {
                string.Join(Path.DirectorySeparatorChar.ToString(), candidate.Take(shared))
            }
        }

        /// Issue #2868: the repo-relative directory that [`projectDirectory`](paramref)
        /// is reproduced at inside the artifact tree, expressed with forward
        /// slashes for MSBuild.
        /// @param projectDirectory The mirrored project's directory.
        /// @param mirrorRoot The mirrored repo root, or `null`.
        /// @returns The repo-relative directory, never empty.
        internal func MirroredProjectDirectory(projectDirectory string, mirrorRoot string?) string {
            var relative string? = if string.IsNullOrEmpty(mirrorRoot) {
                Path.GetFileName(projectDirectory)
            } else {
                Path.GetRelativePath(mirrorRoot!!, projectDirectory)
            }
            relative = (relative ?? string.Empty).Replace('\\', '/').Trim('/')
            return if relative.Length == 0 || relative == "." {
                Path.GetFileName(projectDirectory)
            } else {
                relative
            }
        }

        internal func RestoreTemporaryBuildProps(temporaryBuildProps IEnumerable[(Path string, Original[]?uint8)]) {
            for temporary in temporaryBuildProps.Reverse() {
                if temporary.Original == nil {
                    File.Delete(temporary.Path)
                } else {
                    File.WriteAllBytes(temporary.Path, temporary.Original!!)
                }
            }
        }

        internal func FindEmittedAssembly(
            appRunDir string,
            projectName string,
            config string,
            assemblyName string? = nil
        ) string? {
            let binDir = Path.Combine(appRunDir, "bin", config ?? "Release", "net10.0")
            if !Directory.Exists(binDir) {
                return nil
            }
            let expectedName string? = if string.IsNullOrEmpty(assemblyName) {
                projectName
            } else {
                assemblyName
            }
            let expected = Path.Combine(binDir, expectedName + ".dll")
            return if File.Exists(expected) {
                expected
            } else {
                default(string?)
            }
        }

        internal func HasDeclaredPackageReferences(packageReferences IReadOnlyList[DeclaredProjectItem]?) bool -> (
            packageReferences?.Count ?? 0
        ) > 0

        internal func ApplyDeclaredPackageReferencePolicy(
            packages List[(Id string, Version string)],
            packageReferences IReadOnlyList[DeclaredProjectItem]?
        ) bool {
            let hasDeclaredPackageReferences = HasDeclaredPackageReferences(packageReferences)
            if hasDeclaredPackageReferences {
                packages.Clear()
            }
            return hasDeclaredPackageReferences
        }

        internal func IsRepresentedByProjectReferenceForTest(
            referencePath string,
            projectReferences IReadOnlyList[DeclaredProjectItem]
        ) bool -> IsRepresentedByProjectReference(referencePath, projectReferences)

        /// Scans `dotnet build` output for MSBuild-relayed `GSxxxx` error
        /// lines that (cref:GscInvoker.ParseDiagnostics) cannot recognize
        /// (issue #3634): task/target errors anchored to a non-`.gs` path such
        /// as a `.targets` file or the literal `gsgen` tool name, with a
        /// two-coordinate location and an optional trailing `[project]`
        /// suffix. The id and full message are surfaced verbatim (including any
        /// `[project]` suffix) so the nightly table and fingerprint carry the
        /// real error instead of the synthetic GS9999. Identical repeated lines are
        /// deduplicated — MSBuild prints each error again in its final summary.
        /// @param output The combined stdout+stderr of the `dotnet build` run.
        /// @returns The distinct relayed error diagnostics in output order; empty when none match.
        internal func ParseRelayedGsErrors(output string) IReadOnlyList[GscDiagnostic] -> ParseRelayedErrors(
            output,
            RelayedGsErrorPattern
        )

        /// Scans `dotnet build` output for a relayed error of ANY id shape —
        /// `MSB3202`, `NU1101`, `CS0246` — for the case where the
        /// build failed without emitting a single `GSxxxx` line (issue #3672).
        /// Without this, such a failure reached the caller as an opaque
        /// `GS9999 … no parseable diagnostic` whose truncated output excerpt
        /// routinely captured only leading warning noise, hiding the one real error
        /// far below it. Only consulted after
        /// (cref:ParseRelayedGsErrors) comes back empty.
        /// @param output The combined stdout+stderr of the `dotnet build` run.
        /// @returns The distinct relayed error diagnostics in output order; empty when none match.
        internal func ParseRelayedBuildErrors(output string) IReadOnlyList[GscDiagnostic] -> ParseRelayedErrors(
            output,
            RelayedBuildErrorPattern
        )

        /// Issue #3672: the mirrored-build command line. The compile stage measures
        /// whether the translated G# compiles, so packaging is switched off:
        /// a source project with `<GeneratePackageOnBuild>true` (e.g.
        /// `src/Sdk/Gsharp.NET.Sdk`) otherwise runs its pack targets, which
        /// reach out to sibling REPO projects by literal `.csproj` path —
        /// paths that in a partial mirror are either absent (an `--exclude`d
        /// project) or exist only as `.gsproj`, failing the build with MSB3202
        /// for a reason that has nothing to do with the translation. The property is
        /// global, so it also applies to every project reference in the graph.
        ///
        /// Issue #3674 taught (cref:GSharpProjectTransformer) to redirect
        /// those literal paths at their migrated counterparts, but the suppression
        /// stays: paths outside the migration set stay dangling by design, pack
        /// targets also consume repository assets a partial mirror does not carry
        /// (READMEs, icons, prebuilt output directories), and a mirror has no
        /// reason to spend a compiler publish on producing a NuGet package.
        /// @param generatedProjectPath The mirrored G# project to build.
        /// @param artifactDirectory The external build and log directory.
        /// @param config The build configuration.
        /// @param projectNugetConfig The nuget.config written beside the generated project.
        /// @param warningsNotAsErrors Issue #3782: diagnostic ids to keep at warning severity despite the
        /// mirror's `TreatWarningsAsErrors`. The property is global, so it
        /// applies to every project in the graph — which is the point: the
        /// redundant-`!!` polish loop uses it to make ONE build report the
        /// whole graph's `GS0536` instead of stopping at the first project
        /// that would otherwise error out. `null` (the default)
        /// leaves the mirror's strict settings exactly as they are.
        /// @returns The `dotnet` arguments.
        internal func BuildMirroredBuildArguments(
            generatedProjectPath string,
            artifactDirectory string,
            config string,
            projectNugetConfig string,
            warningsNotAsErrors string? = nil
        ) IReadOnlyList[string] {
            let args = List[string]{
                "build",
                generatedProjectPath,
                "-c",
                config ?? "Release",
                "-p:RestoreConfigFile=" + projectNugetConfig,
                "-p:RestorePackagesPath=" + Path.Combine(artifactDirectory, ".nuget-packages"),
                "-p:Cs2GsArtifactRoot=" + artifactDirectory,
                "-p:GeneratePackageOnBuild=false"
            }
            if !string.IsNullOrEmpty(warningsNotAsErrors) {
                args.Add("-p:WarningsNotAsErrors=" + warningsNotAsErrors)
            }
            return args
        }

        private func ParseRelayedErrors(output string, pattern Regex) IReadOnlyList[GscDiagnostic] {
            let diagnostics = List[GscDiagnostic]()
            if string.IsNullOrEmpty(output) {
                return diagnostics
            }
            let seen = HashSet[string](StringComparer.Ordinal)
            for rawLine in output.Replace("\r\n", "\n").Split('\n') {
                let match = pattern.Match(rawLine.Trim())
                if !match.Success {
                    continue
                }
                let file = if match.Groups["file"].Success {
                    match.Groups["file"].Value.Trim()
                } else {
                    "unknown"
                }
                let line = if match.Groups["line"].Success {
                    int32.Parse(match.Groups["line"].Value)
                } else {
                    1
                }
                let column = if match.Groups["col"].Success {
                    int32.Parse(match.Groups["col"].Value)
                } else {
                    1
                }
                let endLine = if match.Groups["eline"].Success {
                    int32.Parse(match.Groups["eline"].Value)
                } else {
                    line
                }
                let endColumn = if match.Groups["ecol"].Success {
                    int32.Parse(match.Groups["ecol"].Value)
                } else {
                    column
                }
                let diagnostic = GscDiagnostic(
                    match.Groups["id"].Value,
                    match.Groups["msg"].Value.Trim(),
                    "error",
                    file,
                    line,
                    column,
                    endLine,
                    endColumn
                )
                if seen.Add(
                    diagnostic.Id + "|" + diagnostic.File + "|" + diagnostic.Line.ToString() +
                        "," +
                        diagnostic
                        .Column
                        .ToString() + "|" + diagnostic.Message
                ) {
                    diagnostics.Add(diagnostic)
                }
            }
            return diagnostics
        }

        private func FindInheritedBuildProps(projectDirectory string) string? {
            var directory DirectoryInfo? = Directory.GetParent(projectDirectory)
            while directory != nil {
                let candidate = Path.Combine(directory.FullName, "Directory.Build.props")
                if File.Exists(candidate) {
                    return candidate
                }
                directory = directory.Parent
            }
            return nil
        }

        private func ResolveTargetPath(
            projectPath string,
            projectDirectory string?,
            config string,
            artifactDirectory string
        ) string? {
            let result = ProcessRunner.Run(
                "dotnet",
                []string{
                    "msbuild",
                    projectPath,
                    "-getProperty:TargetPath",
                    "-p:Configuration=" + (config ?? "Release"),
                    "-p:Cs2GsArtifactRoot=" + artifactDirectory
                },
                projectDirectory,
                TimeSpan.FromMinutes(2),
                IsolatedNugetEnvironment(artifactDirectory)
            )
            if result.ExitCode != 0 {
                return nil
            }
            let json = Regex.Match(
                result.Stdout ?? string.Empty,
                "\"TargetPath\"\\s*:\\s*\"(?<path>[^\"]+)\"",
                RegexOptions.CultureInvariant
            )
            var candidate string? = if json.Success {
                json.Groups["path"].Value
            } else {
                (result.Stdout ?? string.Empty)
                    .Split([]char{'\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
                    .Select((line string) -> line.Trim())
                    .LastOrDefault(
                    (line string) -> line.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) || line.EndsWith(
                        ".exe",
                        StringComparison.OrdinalIgnoreCase
                    )
                )
            }
            if string.IsNullOrWhiteSpace(candidate) {
                return nil
            }
            candidate = candidate.Replace("\\\\", "\\")
            return Path.GetFullPath(
                if Path.IsPathRooted(candidate) {
                    candidate
                } else {
                    Path.Combine(projectDirectory!!, candidate)
                }
            )
        }

        private func AppendDeclaredItems(sb StringBuilder, items IReadOnlyList[DeclaredProjectItem]?) {
            for group in(items ?? Array.Empty[DeclaredProjectItem]()).GroupBy(
                (item DeclaredProjectItem) -> item.ItemGroupCondition ?? string.Empty
            ) {
                sb.Append('\n')
                sb.Append("  <ItemGroup")
                if !string.IsNullOrEmpty(group.Key) {
                    sb.Append(' ').Append(XAttribute(XName?("Condition")!!, group.Key))
                }
                sb.Append(">\n")
                for item in group {
                    let xml = item.Element.ToString(SaveOptions.DisableFormatting)
                    sb.Append("    ").Append(xml).Append('\n')
                }
                sb.Append("  </ItemGroup>\n")
            }
        }

        private func IsRepresentedByProjectReference(
            referencePath string,
            projectReferences IReadOnlyList[DeclaredProjectItem]?
        ) bool {
            if TryParsePackageFromPath(referencePath, ResolveNugetPackagesRoot()) != nil {
                return true
            }
            let fullReferencePath = Path.GetFullPath(referencePath)
            for projectReference in projectReferences ?? Array.Empty[DeclaredProjectItem]() {
                if !string.IsNullOrEmpty(projectReference.SourceAssemblyName) {
                    var referenceAssemblyName string? = Path.GetFileNameWithoutExtension(fullReferencePath)
                    if File.Exists(fullReferencePath) {
                        try {
                            referenceAssemblyName = AssemblyName.GetAssemblyName(fullReferencePath).Name
                        } catch (BadImageFormatException) {
                            referenceAssemblyName = Path.GetFileNameWithoutExtension(fullReferencePath)
                        } catch (FileLoadException) {
                            referenceAssemblyName = Path.GetFileNameWithoutExtension(fullReferencePath)
                        } catch (FileNotFoundException) {
                            referenceAssemblyName = Path.GetFileNameWithoutExtension(fullReferencePath)
                        } catch (DirectoryNotFoundException) {
                            referenceAssemblyName = Path.GetFileNameWithoutExtension(fullReferencePath)
                        }
                    }
                    if string.Equals(
                        referenceAssemblyName,
                        projectReference.SourceAssemblyName,
                        StringComparison.OrdinalIgnoreCase
                    ) {
                        return true
                    }
                }
                if string.IsNullOrEmpty(projectReference.SourceInclude) {
                    continue
                }
                let projectDirectory string? = Path.GetDirectoryName(projectReference.SourceInclude)
                let relative = Path.GetRelativePath(projectDirectory!!, fullReferencePath)
                if !Path.IsPathRooted(relative) && !relative.Equals("..", StringComparison.Ordinal) &&
                    !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
                    !relative.StartsWith(".." + Path.AltDirectorySeparatorChar, StringComparison.Ordinal) {
                    return true
                }
            }
            return false
        }

        /// Writes a `nuget.config` directly into [`appRunDir`](paramref)
        /// pointing at the repo's `.nugs` local feed (by absolute path) plus
        /// nuget.org. MSBuild's SDK resolver (which resolves `Sdk="Gsharp.NET.Sdk/…"`
        /// before evaluation even starts, independent of any `-p:RestoreConfigFile`
        /// passed to the build) discovers `nuget.config` by walking up from the
        /// project directory the same way `dotnet restore` does; when
        /// [`appRunDir`](paramref) lives outside the repo (any `--out`
        /// other than a repo-nested path), that walk never reaches the repo's own
        /// `nuget.config` and the SDK version fails to resolve (MSB4236).
        /// Writing an equivalent config in the same directory as the generated
        /// `.gsproj` makes it discoverable unconditionally.
        /// @param appRunDir The directory the `.gsproj` is written to.
        /// @param repoRoot The repository root containing the `.nugs` feed.
        private func WriteLocalNugetConfig(appRunDir string, repoRoot string?) {
            WriteLocalNugetConfigFile(Path.Combine(appRunDir, "nuget.config"), repoRoot)
        }

        private func WriteLocalNugetConfigFile(path string, repoRoot string?) {
            let localFeed = Path.Combine(repoRoot!!, ".nugs")
            let sb = StringBuilder()
            sb.Append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
            sb.Append("<configuration>\n")
            sb.Append("  <packageSources>\n")
            sb.Append("    <clear />\n")
            sb.Append(
                "    <add key=\"NuGet official package source\" value=\"https://api.nuget.org/v3/index.json\" />\n"
            )
            sb.Append("    <add key=\"Gsharp local packages\" value=\"").Append(localFeed).Append("\" />\n")
            sb.Append("  </packageSources>\n")
            sb.Append("  <disabledPackageSources>\n")
            sb.Append("    <clear />\n")
            sb.Append("  </disabledPackageSources>\n")
            sb.Append("</configuration>\n")
            File.WriteAllText(path, sb.ToString())
        }

        private func AddOrUpgradePackage(
            packages List[(Id string, Version string)],
            packageIndex Dictionary[string, int32],
            id string,
            version string
        ) {
            if packageIndex.TryGetValue(id, out var existingIndex) {
                let existing = packages[existingIndex]
                if GsharpTestProjectRunner.CompareVersions(version, existing.Version) > 0 {
                    packages[existingIndex] = (existing.Id, version)
                }
                return
            }
            packageIndex[id] = packages.Count
            packages.Add((id, version))
        }

        private func ResolveNugetPackagesRoot() string? {
            let envOverride string? = Environment.GetEnvironmentVariable("NUGET_PACKAGES")
            if !string.IsNullOrEmpty(envOverride) {
                return envOverride
            }
            let home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            return if string.IsNullOrEmpty(home) {
                default(string?)
            } else {
                Path.Combine(home, ".nuget", "packages")
            }
        }

        private func ResolvePinnedPackageVersion(packageId string, config string, explicitVersion string?) string? {
            let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
            if explicitVersion != nil {
                if !SdkPin.IsValidVersion(explicitVersion) {
                    throw ArgumentException(
                        "'" + explicitVersion + "' is not a valid " + packageId + " version.",
                        "explicitVersion"
                    )
                }
                let exactNupkg string? = GsharpTestProjectRunner.FindLocalPackageVersion(
                    repoRoot,
                    packageId,
                    explicitVersion,
                    config
                )
                if exactNupkg != nil {
                    GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, exactNupkg)
                }
                return explicitVersion
            }
            let package_ = GsharpTestProjectRunner.ResolveLocalPackage(repoRoot, packageId, config) ??
                ResolveFallbackPackageFromLocalFeed(repoRoot, packageId)
            if package_ == nil || package_!!.NupkgPath == nil {
                return nil
            }
            GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, package_.NupkgPath)
            return package_.Version
        }

        private func ResolveFallbackSdkPackageFromLocalFeed(repoRoot string?)(
            NupkgPath string,
            Version string
        )? -> ResolveFallbackPackageFromLocalFeed(repoRoot, SdkPackageId)

        private func ResolveFallbackPackageFromLocalFeed(repoRoot string?, packageId string)(
            NupkgPath string,
            Version string
        )? {
            let feed = Path.Combine(repoRoot!!, ".nugs")
            return GsharpTestProjectRunner.ResolveNewestPackage(feed, packageId)
        }

        private func SynthesizeFallbackDiagnostic(
            result ProcessRunResult,
            gsFilePaths IReadOnlyList[string]
        ) GscDiagnostic {
            let relativeFile = if gsFilePaths != nil && gsFilePaths.Count > 0 {
                Path.GetFileName(gsFilePaths[0])
            } else {
                "unknown"
            }
            if !string.IsNullOrEmpty(result.Output) {
                for rawLine in result.Output.Replace("\r\n", "\n").Split('\n') {
                    let match = GenericErrorPattern.Match(rawLine.Trim())
                    if match.Success {
                        let message = "dotnet build: " +
                            match
                            .Groups["code"]
                            .Value +
                            ": " +
                            match
                            .Groups["msg"]
                            .Value
                            .Trim()
                        return GscDiagnostic(match.Groups["code"].Value, message, "error", relativeFile, 1, 1)
                    }
                }
            }
            let fallbackMessage = "dotnet build exited with code " + result.ExitCode.ToString() +
                " and no parseable diagnostic."
            return GscDiagnostic("GS9999", fallbackMessage, "error", relativeFile, 1, 1)
        }
    }
}

/// The outcome of an (cref:SdkCompileRunner.Compile) invocation.
class SdkCompileResult {
    private init(
        isAvailable bool,
        unavailableReason string?,
        exitCode int32,
        output string?,
        diagnostics IReadOnlyList[GscDiagnostic],
        emittedAssemblyPath string?
    ) {
        this.IsAvailable = isAvailable
        this.UnavailableReason = unavailableReason
        this.ExitCode = exitCode
        this.Output = output
        this.Diagnostics = diagnostics ?? Array.Empty[GscDiagnostic]()
        this.EmittedAssemblyPath = emittedAssemblyPath
    }

    /// Gets a value indicating whether a local SDK build could be attempted at all.
    prop IsAvailable bool {
        get;
    }

    /// Gets the reason the SDK build was unavailable, or `null` when available.
    prop UnavailableReason string? {
        get;
    }

    /// Gets the `dotnet build` process exit code.
    prop ExitCode int32 {
        get;
    }

    /// Gets the combined stdout+stderr of the `dotnet build` invocation.
    prop Output string? {
        get;
    }

    /// Gets the parsed diagnostics.
    prop Diagnostics IReadOnlyList[GscDiagnostic] {
        get;
    }

    /// Gets the error-severity diagnostics.
    prop Errors IReadOnlyList[GscDiagnostic] -> this.Diagnostics.Where((d GscDiagnostic) -> d.IsError).ToList()

    /// Gets the absolute path of the built assembly, or `null` when not found.
    prop EmittedAssemblyPath string? {
        get;
    }

    /// Gets a value indicating whether the build passed: exit 0 and zero error-severity diagnostics.
    prop Succeeded bool -> this.IsAvailable && this.ExitCode == 0 && this.Errors.Count == 0

    shared {
        /// Creates an "SDK unavailable" result so the caller can fall back to the gsc-direct path.
        /// @param reason A human-readable reason.
        /// @returns The unavailable result.
        func Unavailable(reason string) SdkCompileResult -> SdkCompileResult(
            false,
            reason,
            -1,
            nil,
            Array.Empty[GscDiagnostic](),
            nil
        )

        /// Creates a completed-build result.
        /// @param exitCode The process exit code.
        /// @param output The combined stdout+stderr.
        /// @param diagnostics The parsed diagnostics.
        /// @param emittedAssemblyPath The built assembly path, or `null`.
        /// @returns The completed result.
        func Completed(
            exitCode int32,
            output string,
            diagnostics IReadOnlyList[GscDiagnostic],
            emittedAssemblyPath string?
        ) SdkCompileResult -> SdkCompileResult(true, nil, exitCode, output, diagnostics, emittedAssemblyPath)
    }
}

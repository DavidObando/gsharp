// <copyright file="IMigrationStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.Threading
import System.Threading.Tasks

/// One ordered stage of the migration pipeline (ADR-0115 §C). The pipeline runs
/// stages as an (cref:IReadOnlyList{IMigrationStage}) and short-circuits
/// on the first failure, so stages 3 (`ilverify`) and 4
/// (`test-parity`) slot in by appending two more implementations — no
/// restructuring of (cref:MigrationPipeline) required.
interface IMigrationStage {
    /// Gets the stage this implementation realizes.
    prop Kind MigrationStageKind {
        get;
    }

    /// Executes the stage against the shared per-app execution context,
    /// mutating it (e.g. recording emitted G# files) for downstream stages.
    /// @param context The shared per-app execution context.
    /// @param cancellationToken A cancellation token.
    /// @returns The stage outcome and any triage artifacts it produced.
    func ExecuteAsync(
        context StageExecutionContext?,
        cancellationToken CancellationToken = default(CancellationToken)
    ) Task[StageOutcome];
}

/// The mutable per-app state threaded through the ordered stages of a single
/// app's migration. Earlier stages publish state (the emitted G# file set) that
/// later stages consume.
class StageExecutionContext {
    /// Initializes a new instance of the (cref:StageExecutionContext)
    /// class using one directory for both generated files and artifacts.
    /// @param app The corpus app being migrated.
    /// @param options The whole-run options.
    /// @param gsc The resolved compiler invoker.
    /// @param appRunDir The combined generated-file and artifact directory.
    /// @param triage The artifact builder pre-stamped with run provenance.
    convenience init(app CorpusApp, options PipelineOptions, gsc GscInvoker, appRunDir string, triage TriageBuilder) {
        init(app, options, gsc, appRunDir, appRunDir, triage)
    }

    /// Initializes a new instance of the (cref:StageExecutionContext) class.
    /// @param app The corpus app being migrated.
    /// @param options The whole-run options.
    /// @param gsc The resolved compiler invoker.
    /// @param projectOutputDir The migrated project directory.
    /// @param artifactDir The external per-project artifact directory.
    /// @param triage The artifact builder pre-stamped with run provenance.
    init(
        app CorpusApp,
        options PipelineOptions,
        gsc GscInvoker,
        projectOutputDir string?,
        artifactDir string,
        triage TriageBuilder
    ) {
        EmittedFiles = List[EmittedGsFile]()
        ExternalReferencePaths = List[string]()
        AnalyzerReferencePaths = List[string]()
        AdditionalGeneratorFiles = List[string]()
        GeneratorGlobalOptions = List[string]()
        BuildOnlyPackageReferences = List[DeclaredPackageReference]()
        PackageReferences = List[DeclaredProjectItem]()
        ProjectReferences = List[DeclaredProjectItem]()
        GeneratedFriendAssemblies = HashSet[string](StringComparer.Ordinal)
        AllowedTestFailures = List[string]()
        StaleTestAllowListEntries = List[string]()
        this.App = app ?? throw ArgumentNullException("app")
        this.Options = options ?? throw ArgumentNullException("options")
        this.Gsc = gsc ?? throw ArgumentNullException("gsc")
        this.ProjectOutputDir = projectOutputDir ?? throw ArgumentNullException("projectOutputDir")
        this.ArtifactDir = artifactDir ?? throw ArgumentNullException("artifactDir")
        this.Triage = triage ?? throw ArgumentNullException("triage")
    }

    /// Gets the corpus app being migrated.
    prop App CorpusApp {
        get;
    }

    /// Gets the whole-run options.
    prop Options PipelineOptions {
        get;
    }

    /// Gets the resolved compiler invoker.
    prop Gsc GscInvoker {
        get;
    }

    /// Gets the directory containing the migrated project and G# sources.
    prop ProjectOutputDir string {
        get;
    }

    /// Gets the per-project directory for logs, triage, and build intermediates.
    prop ArtifactDir string {
        get;
    }

    /// Gets the historical combined output directory. New code should use
    /// (cref:ProjectOutputDir) or (cref:ArtifactDir) explicitly.
    prop AppRunDir string -> this.ProjectOutputDir

    /// Gets the artifact builder pre-stamped with run provenance.
    prop Triage TriageBuilder {
        get;
    }

    /// Gets the G# files emitted by the Translate stage for downstream stages.
    prop EmittedFiles List[EmittedGsFile] {
        get;
    }

    /// Gets the absolute paths of the external (NuGet package) assemblies the
    /// C# project resolved against, captured by the Translate stage from the
    /// Roslyn compilation's metadata references. The Compile stage adds these to
    /// gsc's `/reference:` set so package types (e.g. `System.Management`,
    /// EF Core, Spectre.Console) resolve. Framework assemblies and stripped
    /// sibling-project outputs are excluded downstream (Refs #914).
    prop ExternalReferencePaths List[string] {
        get;
    }

    /// Gets the absolute paths of the app's own analyzer/generator assemblies,
    /// captured by the Translate stage from the Roslyn project's
    /// `AnalyzerReferences` (issue #2215). The Compile stage forwards
    /// these to gsc's `/analyzer:` flag so gsc spawns `gsgen` and
    /// folds generator output into the same compile a real MSBuild build of
    /// this project would produce.
    prop AnalyzerReferencePaths List[string] {
        get;
    }

    /// Gets the non-source generator inputs (issue #2223) to forward to gsc's
    /// `/additionalfile:` flag — the project's `@(AdditionalFiles)`
    /// plus discovered `.axaml`, each optionally suffixed with
    /// `;key=value` metadata (e.g. `;SourceItemGroup=AvaloniaXaml`) so
    /// a file/options-driven generator (Avalonia's XAML name generator)
    /// recognizes them. Populated by the Translate stage from the loaded
    /// project's additional files.
    prop AdditionalGeneratorFiles List[string] {
        get;
    }

    /// Gets the project-wide generator options (issue #2223) to forward to gsc's
    /// `/globaloption:` flag as `key=value` pairs (surfaced to
    /// generators as `build_property.*`). Populated by the Translate stage.
    prop GeneratorGlobalOptions List[string] {
        get;
    }

    /// Gets or sets the source project's root namespace, captured by the
    /// Translate stage for the SDK compile project.
    prop RootNamespace string

    /// Gets or sets the source project's assembly name, captured by the
    /// Translate stage for the SDK compile project.
    prop AssemblyName string?

    /// Gets or sets a value indicating whether the app is translated against the G# analyzer API.
    prop IsAnalyzerProject bool

    /// Gets or sets a value indicating whether the analyzer detector classified the app as a test project.
    prop IsAnalyzerTestProject bool

    /// Gets the source project's declared build/dev-only `PackageReference`s
    /// (issue #2267) — e.g. a version-bumped `Nerdbank.GitVersioning` — that
    /// must be re-declared into the isolated `--via-sdk` gsproj because they
    /// contribute no compile-time reference DLL and so are otherwise silently
    /// dropped by (cref:SdkCompileRunner)'s DLL-to-package reconstruction.
    /// Populated by the Translate stage; only consumed by the `--via-sdk`
    /// compile path (the gsc-direct path has no notion of `PackageReference`
    /// items at all).
    prop BuildOnlyPackageReferences List[DeclaredPackageReference] {
        get;
    }

    /// Gets or sets a value indicating whether the generated app's copied
    /// `Directory.Packages.props` actually enables NuGet Central Package
    /// Management (`ManagePackageVersionsCentrally`, issue #2319). Set by
    /// the Translate stage; consumed by the `--via-sdk` compile path so any
    /// `PackageReference` it synthesizes (e.g. the bumped nbgv reference)
    /// omits `Version=` — CPM forbids that attribute on project-level
    /// `PackageReference` items and NuGet fails restore (NU1008) otherwise.
    prop UsesCentralPackageManagement bool

    /// Gets the source project's declared PackageReference items. A below-floor
    /// literal `Nerdbank.GitVersioning` `Version` declared directly on
    /// this list's item (as opposed to split across an ancestor
    /// `Directory.Build.props`/`Directory.Packages.props`, which
    /// (cref:BuildOnlyPackageReferences) instead covers) is already
    /// bumped by the Translate stage (issue #2319) before being copied verbatim
    /// into the generated `.gsproj`.
    prop PackageReferences List[DeclaredProjectItem] {
        get;
    }

    /// Gets the source project's declared ProjectReference items.
    prop ProjectReferences List[DeclaredProjectItem] {
        get;
    }

    /// Gets friend assemblies contributed by generated C# sources, including
    /// SDK-generated `InternalsVisibleTo` items.
    prop GeneratedFriendAssemblies ISet[string] {
        get;
    }

    /// Gets or sets the absolute path of the assembly emitted by the Compile
    /// stage, published for the IL-verify stage to read (ADR-0115 §C). It is
    /// `null` until a green stage-2 compile has run.
    prop EmittedAssemblyPath string?

    /// Gets or sets a value indicating whether evaluated MSBuild properties
    /// identify a test project.
    prop IsTestProject bool

    /// Gets the mirrored test failures that (cref:PipelineOptions.TestParityAllowList)
    /// covered in this app's run (issue #3885). Populated even when the app
    /// still fails, and ALWAYS reported: an allow-list that silences its own
    /// entries is the dangerous kind.
    prop AllowedTestFailures List[string] {
        get;
    }

    /// Gets the allow-list entries for this app whose test did NOT fail in a
    /// completed run (issue #3885) — they should be removed. Advisory, mirroring
    /// how `greenApps` reports newly-green apps to bank rather than failing
    /// the run over them.
    prop StaleTestAllowListEntries List[string] {
        get;
    }

    /// Gets or sets the per-test-name parity summary the test-parity stage
    /// recorded for a completed mirrored test run (issue #4633), carried into
    /// the run record PASS or FAIL. `null` when no completed
    /// mirrored run happened (this file is nullable-oblivious, like the
    /// sibling (cref:EmittedAssemblyPath)).
    prop TestNameParity TestNameParitySummary
}

/// One emitted G# file plus the C# document it came from, published by the
/// Translate stage and consumed by the Compile stage.
class EmittedGsFile {
    /// Initializes a new instance of the (cref:EmittedGsFile) class.
    /// @param gsPath The absolute path of the written `.gs` file.
    /// @param relativeGsPath The run-relative path of the `.gs` file (for artifacts).
    /// @param csFilePath The originating C# file path.
    /// @param gsharpSource The emitted G# source text.
    init(gsPath string?, relativeGsPath string, csFilePath string?, gsharpSource string) {
        this.GsPath = gsPath
        this.RelativeGsPath = relativeGsPath
        this.CsFilePath = csFilePath
        this.GSharpSource = gsharpSource
    }

    /// Gets the absolute path of the written `.gs` file.
    prop GsPath string? {
        get;
    }

    /// Gets the run-relative path of the `.gs` file.
    prop RelativeGsPath string {
        get;
    }

    /// Gets the originating C# file path.
    prop CsFilePath string? {
        get;
    }

    /// Gets the emitted G# source text.
    prop GSharpSource string {
        get;
    }

    /// Gets or sets the producing compilation's build-generated source evidence.
    /// Authored sources (including checked-in generated code) have no payload.
    prop GeneratedSource GeneratedValidationSource?

    /// Gets or sets a value indicating whether this file was emitted from a
    /// referenced (`ProjectReference`) project rather than the app under
    /// migration. Such files are included as compile inputs so the app's uses of
    /// sibling types resolve, but the Compile stage attributes errors only to
    /// app-owned files — a referenced project's own gaps are measured in its own
    /// run, not charged against every dependent (Refs #914).
    prop IsFromReferencedProject bool
}

/// The result of running one stage: a pass/fail status and any triage artifacts
/// produced (ADR-0115 §C/§D).
class StageOutcome {
    private init(status StageStatus, artifacts IReadOnlyList[TriageArtifact]) {
        this.Status = status
        this.Artifacts = artifacts ?? Array.Empty[TriageArtifact]()
    }

    /// Gets the stage status.
    prop Status StageStatus {
        get;
    }

    /// Gets the triage artifacts the stage produced (empty on success).
    prop Artifacts IReadOnlyList[TriageArtifact] {
        get;
    }

    shared {
        /// Creates a passing outcome with no artifacts.
        /// @returns A passing (cref:StageOutcome).
        func Passed() StageOutcome -> StageOutcome(StageStatus.Passed, Array.Empty[TriageArtifact]())

        /// Creates a skipped outcome (issue #1749 mode 1): the stage ran but a
        /// verification it depends on is genuinely unavailable (e.g. no
        /// locally-built SDK, or a downstream translation step that has not landed
        /// yet) — "not verified", distinct from both (cref:Passed) ("verified
        /// green") and (cref:Failed) ("verified and broke"). Never use this
        /// for a build/test that ran and broke; that is a real regression and must
        /// be reported (cref:Failed).
        /// @returns A skipped (cref:StageOutcome).
        func Skipped() StageOutcome -> StageOutcome(StageStatus.Skipped, Array.Empty[TriageArtifact]())

        /// Creates a failing outcome carrying the supplied artifacts.
        /// @param artifacts The triage artifacts that describe the failure.
        /// @returns A failing (cref:StageOutcome).
        func Failed(artifacts IReadOnlyList[TriageArtifact]) StageOutcome -> StageOutcome(StageStatus.Failed, artifacts)
    }
}

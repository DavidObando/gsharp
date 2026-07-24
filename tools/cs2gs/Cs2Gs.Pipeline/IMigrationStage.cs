// <copyright file="IMigrationStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Cs2Gs.Pipeline;

/// <summary>
/// One ordered stage of the migration pipeline (ADR-0115 §C). The pipeline runs
/// stages as an <see cref="IReadOnlyList{IMigrationStage}"/> and short-circuits
/// on the first failure, so stages 3 (<c>ilverify</c>) and 4
/// (<c>test-parity</c>) slot in by appending two more implementations — no
/// restructuring of <see cref="MigrationPipeline"/> required.
/// </summary>
public interface IMigrationStage
{
    /// <summary>Gets the stage this implementation realizes.</summary>
    MigrationStageKind Kind { get; }

    /// <summary>
    /// Executes the stage against the shared per-app execution context,
    /// mutating it (e.g. recording emitted G# files) for downstream stages.
    /// </summary>
    /// <param name="context">The shared per-app execution context.</param>
    /// <param name="cancellationToken">A cancellation token.</param>
    /// <returns>The stage outcome and any triage artifacts it produced.</returns>
    Task<StageOutcome> ExecuteAsync(StageExecutionContext context, CancellationToken cancellationToken = default);
}

/// <summary>
/// The mutable per-app state threaded through the ordered stages of a single
/// app's migration. Earlier stages publish state (the emitted G# file set) that
/// later stages consume.
/// </summary>
public sealed class StageExecutionContext
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StageExecutionContext"/>
    /// class using one directory for both generated files and artifacts.
    /// </summary>
    /// <param name="app">The corpus app being migrated.</param>
    /// <param name="options">The whole-run options.</param>
    /// <param name="gsc">The resolved compiler invoker.</param>
    /// <param name="appRunDir">The combined generated-file and artifact directory.</param>
    /// <param name="triage">The artifact builder pre-stamped with run provenance.</param>
    public StageExecutionContext(
        CorpusApp app,
        PipelineOptions options,
        GscInvoker gsc,
        string appRunDir,
        TriageBuilder triage)
        : this(app, options, gsc, appRunDir, appRunDir, triage)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StageExecutionContext"/> class.
    /// </summary>
    /// <param name="app">The corpus app being migrated.</param>
    /// <param name="options">The whole-run options.</param>
    /// <param name="gsc">The resolved compiler invoker.</param>
    /// <param name="projectOutputDir">The migrated project directory.</param>
    /// <param name="artifactDir">The external per-project artifact directory.</param>
    /// <param name="triage">The artifact builder pre-stamped with run provenance.</param>
    public StageExecutionContext(
        CorpusApp app,
        PipelineOptions options,
        GscInvoker gsc,
        string projectOutputDir,
        string artifactDir,
        TriageBuilder triage)
    {
        this.App = app ?? throw new ArgumentNullException(nameof(app));
        this.Options = options ?? throw new ArgumentNullException(nameof(options));
        this.Gsc = gsc ?? throw new ArgumentNullException(nameof(gsc));
        this.ProjectOutputDir = projectOutputDir ?? throw new ArgumentNullException(nameof(projectOutputDir));
        this.ArtifactDir = artifactDir ?? throw new ArgumentNullException(nameof(artifactDir));
        this.Triage = triage ?? throw new ArgumentNullException(nameof(triage));
    }

    /// <summary>Gets the corpus app being migrated.</summary>
    public CorpusApp App { get; }

    /// <summary>Gets the whole-run options.</summary>
    public PipelineOptions Options { get; }

    /// <summary>Gets the resolved compiler invoker.</summary>
    public GscInvoker Gsc { get; }

    /// <summary>Gets the directory containing the migrated project and G# sources.</summary>
    public string ProjectOutputDir { get; }

    /// <summary>Gets the per-project directory for logs, triage, and build intermediates.</summary>
    public string ArtifactDir { get; }

    /// <summary>
    /// Gets the historical combined output directory. New code should use
    /// <see cref="ProjectOutputDir"/> or <see cref="ArtifactDir"/> explicitly.
    /// </summary>
    public string AppRunDir => this.ProjectOutputDir;

    /// <summary>Gets the artifact builder pre-stamped with run provenance.</summary>
    public TriageBuilder Triage { get; }

    /// <summary>Gets the G# files emitted by the Translate stage for downstream stages.</summary>
    public List<EmittedGsFile> EmittedFiles { get; } = new List<EmittedGsFile>();

    /// <summary>
    /// Gets the absolute paths of the external (NuGet package) assemblies the
    /// C# project resolved against, captured by the Translate stage from the
    /// Roslyn compilation's metadata references. The Compile stage adds these to
    /// gsc's <c>/reference:</c> set so package types (e.g. <c>System.Management</c>,
    /// EF Core, Spectre.Console) resolve. Framework assemblies and stripped
    /// sibling-project outputs are excluded downstream (Refs #914).
    /// </summary>
    public List<string> ExternalReferencePaths { get; } = new List<string>();

    /// <summary>
    /// Gets the absolute paths of the app's own analyzer/generator assemblies,
    /// captured by the Translate stage from the Roslyn project's
    /// <c>AnalyzerReferences</c> (issue #2215). The Compile stage forwards
    /// these to gsc's <c>/analyzer:</c> flag so gsc spawns <c>gsgen</c> and
    /// folds generator output into the same compile a real MSBuild build of
    /// this project would produce.
    /// </summary>
    public List<string> AnalyzerReferencePaths { get; } = new List<string>();

    /// <summary>
    /// Gets the non-source generator inputs (issue #2223) to forward to gsc's
    /// <c>/additionalfile:</c> flag — the project's <c>@(AdditionalFiles)</c>
    /// plus discovered <c>.axaml</c>, each optionally suffixed with
    /// <c>;key=value</c> metadata (e.g. <c>;SourceItemGroup=AvaloniaXaml</c>) so
    /// a file/options-driven generator (Avalonia's XAML name generator)
    /// recognizes them. Populated by the Translate stage from the loaded
    /// project's additional files.
    /// </summary>
    public List<string> AdditionalGeneratorFiles { get; } = new List<string>();

    /// <summary>
    /// Gets the project-wide generator options (issue #2223) to forward to gsc's
    /// <c>/globaloption:</c> flag as <c>key=value</c> pairs (surfaced to
    /// generators as <c>build_property.*</c>). Populated by the Translate stage.
    /// </summary>
    public List<string> GeneratorGlobalOptions { get; } = new List<string>();

    /// <summary>
    /// Gets or sets the source project's root namespace, captured by the
    /// Translate stage for the SDK compile project.
    /// </summary>
    public string RootNamespace { get; set; }

    /// <summary>
    /// Gets the source project's declared build/dev-only <c>PackageReference</c>s
    /// (issue #2267) — e.g. a version-bumped <c>Nerdbank.GitVersioning</c> — that
    /// must be re-declared into the isolated <c>--via-sdk</c> gsproj because they
    /// contribute no compile-time reference DLL and so are otherwise silently
    /// dropped by <see cref="SdkCompileRunner"/>'s DLL-to-package reconstruction.
    /// Populated by the Translate stage; only consumed by the <c>--via-sdk</c>
    /// compile path (the gsc-direct path has no notion of <c>PackageReference</c>
    /// items at all).
    /// </summary>
    public List<DeclaredPackageReference> BuildOnlyPackageReferences { get; } = new List<DeclaredPackageReference>();

    /// <summary>
    /// Gets or sets a value indicating whether the generated app's copied
    /// <c>Directory.Packages.props</c> actually enables NuGet Central Package
    /// Management (<c>ManagePackageVersionsCentrally</c>, issue #2319). Set by
    /// the Translate stage; consumed by the <c>--via-sdk</c> compile path so any
    /// <c>PackageReference</c> it synthesizes (e.g. the bumped nbgv reference)
    /// omits <c>Version=</c> — CPM forbids that attribute on project-level
    /// <c>PackageReference</c> items and NuGet fails restore (NU1008) otherwise.
    /// </summary>
    public bool UsesCentralPackageManagement { get; set; }

    /// <summary>
    /// Gets the source project's declared PackageReference items. A below-floor
    /// literal <c>Nerdbank.GitVersioning</c> <c>Version</c> declared directly on
    /// this list's item (as opposed to split across an ancestor
    /// <c>Directory.Build.props</c>/<c>Directory.Packages.props</c>, which
    /// <see cref="BuildOnlyPackageReferences"/> instead covers) is already
    /// bumped by the Translate stage (issue #2319) before being copied verbatim
    /// into the generated <c>.gsproj</c>.
    /// </summary>
    public List<DeclaredProjectItem> PackageReferences { get; } = new List<DeclaredProjectItem>();

    /// <summary>Gets the source project's declared ProjectReference items.</summary>
    public List<DeclaredProjectItem> ProjectReferences { get; } = new List<DeclaredProjectItem>();

    /// <summary>
    /// Gets or sets the absolute path of the assembly emitted by the Compile
    /// stage, published for the IL-verify stage to read (ADR-0115 §C). It is
    /// <see langword="null"/> until a green stage-2 compile has run.
    /// </summary>
    public string EmittedAssemblyPath { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether evaluated MSBuild properties
    /// identify a test project.
    /// </summary>
    public bool IsTestProject { get; set; }
}

/// <summary>
/// One emitted G# file plus the C# document it came from, published by the
/// Translate stage and consumed by the Compile stage.
/// </summary>
public sealed class EmittedGsFile
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EmittedGsFile"/> class.
    /// </summary>
    /// <param name="gsPath">The absolute path of the written <c>.gs</c> file.</param>
    /// <param name="relativeGsPath">The run-relative path of the <c>.gs</c> file (for artifacts).</param>
    /// <param name="csFilePath">The originating C# file path.</param>
    /// <param name="gsharpSource">The emitted G# source text.</param>
    public EmittedGsFile(string gsPath, string relativeGsPath, string csFilePath, string gsharpSource)
    {
        this.GsPath = gsPath;
        this.RelativeGsPath = relativeGsPath;
        this.CsFilePath = csFilePath;
        this.GSharpSource = gsharpSource;
    }

    /// <summary>Gets the absolute path of the written <c>.gs</c> file.</summary>
    public string GsPath { get; }

    /// <summary>Gets the run-relative path of the <c>.gs</c> file.</summary>
    public string RelativeGsPath { get; }

    /// <summary>Gets the originating C# file path.</summary>
    public string CsFilePath { get; }

    /// <summary>Gets the emitted G# source text.</summary>
    public string GSharpSource { get; }

    /// <summary>
    /// Gets or sets a value indicating whether this file was emitted from a
    /// referenced (<c>ProjectReference</c>) project rather than the app under
    /// migration. Such files are included as compile inputs so the app's uses of
    /// sibling types resolve, but the Compile stage attributes errors only to
    /// app-owned files — a referenced project's own gaps are measured in its own
    /// run, not charged against every dependent (Refs #914).
    /// </summary>
    public bool IsFromReferencedProject { get; set; }
}

/// <summary>
/// The result of running one stage: a pass/fail status and any triage artifacts
/// produced (ADR-0115 §C/§D).
/// </summary>
public sealed class StageOutcome
{
    private StageOutcome(StageStatus status, IReadOnlyList<TriageArtifact> artifacts)
    {
        this.Status = status;
        this.Artifacts = artifacts ?? Array.Empty<TriageArtifact>();
    }

    /// <summary>Gets the stage status.</summary>
    public StageStatus Status { get; }

    /// <summary>Gets the triage artifacts the stage produced (empty on success).</summary>
    public IReadOnlyList<TriageArtifact> Artifacts { get; }

    /// <summary>
    /// Creates a passing outcome with no artifacts.
    /// </summary>
    /// <returns>A passing <see cref="StageOutcome"/>.</returns>
    public static StageOutcome Passed() => new StageOutcome(StageStatus.Passed, Array.Empty<TriageArtifact>());

    /// <summary>
    /// Creates a skipped outcome (issue #1749 mode 1): the stage ran but a
    /// verification it depends on is genuinely unavailable (e.g. no
    /// locally-built SDK, or a downstream translation step that has not landed
    /// yet) — "not verified", distinct from both <see cref="Passed"/> ("verified
    /// green") and <see cref="Failed"/> ("verified and broke"). Never use this
    /// for a build/test that ran and broke; that is a real regression and must
    /// be reported <see cref="Failed"/>.
    /// </summary>
    /// <returns>A skipped <see cref="StageOutcome"/>.</returns>
    public static StageOutcome Skipped() => new StageOutcome(StageStatus.Skipped, Array.Empty<TriageArtifact>());

    /// <summary>Creates a failing outcome carrying the supplied artifacts.</summary>
    /// <param name="artifacts">The triage artifacts that describe the failure.</param>
    /// <returns>A failing <see cref="StageOutcome"/>.</returns>
    public static StageOutcome Failed(IReadOnlyList<TriageArtifact> artifacts) =>
        new StageOutcome(StageStatus.Failed, artifacts);
}

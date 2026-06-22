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
    /// Initializes a new instance of the <see cref="StageExecutionContext"/> class.
    /// </summary>
    /// <param name="app">The corpus app being migrated.</param>
    /// <param name="options">The whole-run options.</param>
    /// <param name="gsc">The resolved compiler invoker.</param>
    /// <param name="appRunDir">The per-app output directory under the run dir.</param>
    /// <param name="triage">The artifact builder pre-stamped with run provenance.</param>
    public StageExecutionContext(
        CorpusApp app,
        PipelineOptions options,
        GscInvoker gsc,
        string appRunDir,
        TriageBuilder triage)
    {
        this.App = app ?? throw new ArgumentNullException(nameof(app));
        this.Options = options ?? throw new ArgumentNullException(nameof(options));
        this.Gsc = gsc ?? throw new ArgumentNullException(nameof(gsc));
        this.AppRunDir = appRunDir ?? throw new ArgumentNullException(nameof(appRunDir));
        this.Triage = triage ?? throw new ArgumentNullException(nameof(triage));
    }

    /// <summary>Gets the corpus app being migrated.</summary>
    public CorpusApp App { get; }

    /// <summary>Gets the whole-run options.</summary>
    public PipelineOptions Options { get; }

    /// <summary>Gets the resolved compiler invoker.</summary>
    public GscInvoker Gsc { get; }

    /// <summary>Gets the per-app output directory under the run dir.</summary>
    public string AppRunDir { get; }

    /// <summary>Gets the artifact builder pre-stamped with run provenance.</summary>
    public TriageBuilder Triage { get; }

    /// <summary>Gets the G# files emitted by the Translate stage for downstream stages.</summary>
    public List<EmittedGsFile> EmittedFiles { get; } = new List<EmittedGsFile>();
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

    /// <summary>Creates a passing outcome with no artifacts.</summary>
    /// <returns>A passing <see cref="StageOutcome"/>.</returns>
    public static StageOutcome Passed() => new StageOutcome(StageStatus.Passed, Array.Empty<TriageArtifact>());

    /// <summary>Creates a failing outcome carrying the supplied artifacts.</summary>
    /// <param name="artifacts">The triage artifacts that describe the failure.</param>
    /// <returns>A failing <see cref="StageOutcome"/>.</returns>
    public static StageOutcome Failed(IReadOnlyList<TriageArtifact> artifacts) =>
        new StageOutcome(StageStatus.Failed, artifacts);
}

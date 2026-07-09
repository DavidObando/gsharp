// <copyright file="TestParityStage.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Stage 4 (ADR-0115 §C/§E): prove the migrated program behaves identically to
/// the original C# against the captured parity oracle. Two modes, selected by
/// the corpus app:
/// <list type="bullet">
/// <item><description>
/// <b>Executable apps with a stdout golden</b> (e.g. L1) → <b>stdout parity</b>:
/// run the stage-2/3 emitted assembly (<c>dotnet &lt;emitted&gt;.dll</c>),
/// capture stdout, and compare it to <c>baseline.stdout.golden</c> (normalizing
/// the trailing newline only). A mismatch yields a <c>test-parity-failure</c>
/// artifact (<c>STDOUT-MISMATCH</c>).
/// </description></item>
/// <item><description>
/// <b>Library apps with a <c>.Tests</c> oracle</b> (L2/L3) → <b>xUnit
/// pass/fail-set parity</b>: translate the C# <c>.Tests</c> project to a G# xUnit
/// project, build it against the locally-built <c>Gsharp.NET.Sdk</c>, run
/// <c>dotnet test</c>, parse the TRX, and compare the outcome set to
/// <c>baseline.tests.json</c>. Any missing/extra/outcome-mismatch test yields a
/// <c>test-parity-failure</c> artifact. The library path depends on
/// C#-xUnit-test → G# translation (the <i>map-advanced</i> step); until a test
/// project translates cleanly the stage <b>skips the library path with an
/// explicit, recorded reason</b> rather than fabricating a pass.
/// </description></item>
/// </list>
/// Runs only after a green stage-3 (it short-circuits with the rest), so L2/L3
/// — which stop at stage 1 today — never reach it until they translate.
/// </summary>
public sealed class TestParityStage : IMigrationStage
{
    private readonly GsharpTestProjectRunner libraryRunner;

    /// <summary>
    /// Initializes a new instance of the <see cref="TestParityStage"/> class.
    /// </summary>
    /// <param name="libraryRunner">
    /// The live library xUnit runner; when <see langword="null"/> a default
    /// runner that discovers the repo root is used.
    /// </param>
    public TestParityStage(GsharpTestProjectRunner libraryRunner = null)
    {
        this.libraryRunner = libraryRunner ?? new GsharpTestProjectRunner();
    }

    /// <inheritdoc/>
    public MigrationStageKind Kind => MigrationStageKind.TestParity;

    /// <inheritdoc/>
    public async Task<StageOutcome> ExecuteAsync(
        StageExecutionContext context,
        CancellationToken cancellationToken = default)
    {
        if (context is null)
        {
            throw new ArgumentNullException(nameof(context));
        }

        if (IsStdoutEligible(context))
        {
            return this.RunStdoutParity(context);
        }

        if (IsLibraryEligible(context))
        {
            return await this.RunLibraryParityAsync(context, cancellationToken).ConfigureAwait(false);
        }

        // No parity oracle applies to this app (e.g. an executable with no golden
        // or a library with no `.Tests` baseline): nothing to verify.
        this.Note(context, "no parity oracle (no stdout golden and no .Tests baseline); nothing to verify.");
        return StageOutcome.Passed();
    }

    private static bool IsStdoutEligible(StageExecutionContext context) =>
        context.App.TargetKind == TargetKind.Exe &&
        !string.IsNullOrEmpty(context.App.StdoutGolden) &&
        File.Exists(context.App.StdoutGolden) &&
        !string.IsNullOrEmpty(context.EmittedAssemblyPath) &&
        File.Exists(context.EmittedAssemblyPath);

    private static bool IsLibraryEligible(StageExecutionContext context) =>
        !string.IsNullOrEmpty(context.App.TestsProjectPath) &&
        File.Exists(context.App.TestsProjectPath) &&
        !string.IsNullOrEmpty(context.App.TestsBaselinePath) &&
        File.Exists(context.App.TestsBaselinePath);

    private StageOutcome RunStdoutParity(StageExecutionContext context)
    {
        (int exit, string stdout, string stderr, bool timedOut) =
            RunProgram(context.EmittedAssemblyPath, context.AppRunDir);

        string golden = File.ReadAllText(context.App.StdoutGolden);
        StdoutParityResult parity = StdoutParity.Compare(golden, stdout);

        string note = $"stdout parity: exit={exit}; match={parity.IsMatch}; timedOut={timedOut}." +
            (parity.IsMatch ? string.Empty : " " + parity.Describe()) +
            (string.IsNullOrWhiteSpace(stderr) ? string.Empty : "\nstderr:\n" + stderr);
        this.Note(context, note);

        if (timedOut)
        {
            // A codegen bug producing an infinite loop must surface as a named
            // parity failure, not an unattended-CI hang (#1748).
            StdoutParityResult timeoutDiff = StdoutParityResult.Mismatch(
                0, "process to complete", "process timed out");
            TriageArtifact timeoutArtifact = context.Triage.TestParityStdoutFailure(
                timeoutDiff, EmittedGsRelative(context));
            return StageOutcome.Failed(new[] { timeoutArtifact });
        }

        if (parity.IsMatch && exit == 0)
        {
            return StageOutcome.Passed();
        }

        if (parity.IsMatch && exit != 0)
        {
            // Output matched but the process exited non-zero — still a behavioral
            // divergence from the (green) C# baseline. Report it as a stdout-shape
            // failure carrying the exit code.
            StdoutParityResult exitDiff = StdoutParityResult.Mismatch(
                0, "exit code 0", "exit code " + exit);
            TriageArtifact exitArtifact = context.Triage.TestParityStdoutFailure(
                exitDiff, EmittedGsRelative(context));
            return StageOutcome.Failed(new[] { exitArtifact });
        }

        TriageArtifact artifact = context.Triage.TestParityStdoutFailure(parity, EmittedGsRelative(context));
        return StageOutcome.Failed(new[] { artifact });
    }

    private async Task<StageOutcome> RunLibraryParityAsync(
        StageExecutionContext context,
        CancellationToken cancellationToken)
    {
        // Translate the C# `.Tests` project to G#. Until C#-xUnit-test → G#
        // translation (map-advanced) is complete, an unsupported construct or a
        // round-trip failure means the live library path cannot run yet; the
        // stage records the reason and skips rather than fabricating a pass.
        TranslatedProject tests = await TranslateProjectAsync(
            context.App.TestsProjectPath, cancellationToken).ConfigureAwait(false);

        if (tests.LoadErrors is not null)
        {
            this.Note(context, "library xUnit parity FAILED: .Tests project did not load.");
            TriageArtifact loadArtifact = context.Triage.ProjectLoadFailure(
                MigrationStageKind.TestParity,
                TriageCategory.TestParityFailure,
                tests.LoadErrors);
            return StageOutcome.Failed(new[] { loadArtifact });
        }

        if (tests.PendingReason is not null)
        {
            // Gated intentionally (ADR-0115 §E) until test-translation lands —
            // "not verified yet", never a fabricated pass (issue #1749).
            this.Note(context, "library xUnit parity SKIPPED: " + tests.PendingReason);
            return StageOutcome.Skipped();
        }

        BaselineTestsOracle oracle = BaselineTestsOracle.Load(context.App.TestsBaselinePath);

        string libraryName = MigrationPipeline.SanitizeAppId(context.App.Id).Replace("corpus_", string.Empty);
        var project = new GsharpTestProject
        {
            LibraryName = libraryName,
            LibraryRootNamespace = libraryName.Replace('-', '_'),
            LibraryFiles = context.EmittedFiles
                .Select(f => new GsharpSourceFile(Path.GetFileName(f.GsPath), f.GSharpSource))
                .ToList(),
            TestsName = libraryName + ".Tests",
            TestsRootNamespace = libraryName.Replace('-', '_') + ".Tests",
            TestFiles = tests.Files,
        };

        string workDir = Path.Combine(context.AppRunDir, "test-parity");
        GsharpTestRunResult run = this.libraryRunner.Run(project, workDir);

        if (run.Status == GsharpTestRunStatus.Unavailable)
        {
            // The SDK/tooling this verification needs is genuinely absent (no
            // locally-built Gsharp.NET.Sdk nupkg) — "not verified", not a pass
            // (issue #1749 mode 1).
            this.Note(context, "library xUnit parity SKIPPED: " + run.UnavailableReason);
            return StageOutcome.Skipped();
        }

        if (run.Status == GsharpTestRunStatus.BuildFailed)
        {
            // A library that green-built standalone `gsc` in stage 2 but fails
            // to build its translated G# test project here is a real
            // regression, not "translation pending" — report it as a failure
            // (issue #1749 mode 1), never a fabricated pass.
            string buildNote = "library xUnit parity FAILED: the translated G# test project did not build.\n" +
                Truncate(run.Output);
            this.Note(context, buildNote);
            TriageArtifact buildArtifact = context.Triage.TestParityLibraryBuildFailure(
                run.Output, EmittedGsRelative(context));
            return StageOutcome.Failed(new[] { buildArtifact });
        }

        TestParityResult parity = TestParityComparison.Compare(oracle.Tests, run.Results);
        string parityNote = $"library xUnit parity: {run.Results.Count} ran vs {oracle.Tests.Count} baseline; " +
            $"match={parity.IsMatch}; diffs={parity.Differences.Count}.";
        this.Note(context, parityNote);

        if (parity.IsMatch)
        {
            return StageOutcome.Passed();
        }

        string gsFile = tests.Files.Count > 0 ? project.TestsName + "/" + tests.Files[0].FileName : null;
        var artifacts = parity.Differences
            .Select(diff => context.Triage.TestParityTestFailure(diff, gsFile))
            .ToList();
        return StageOutcome.Failed(artifacts);
    }

    private static async Task<TranslatedProject> TranslateProjectAsync(
        string projectPath,
        CancellationToken cancellationToken)
    {
        LoadedCSharpProject project = await CSharpProjectLoader
            .LoadProjectAsync(projectPath, cancellationToken)
            .ConfigureAwait(false);

        // Issue #1742: same load-failure gate as TranslateStage, scoped to the
        // MSBuild workspace load failure signal (not every C# semantic error —
        // some corpus fixtures deliberately carry those to exercise a later
        // stage). A `.Tests` project that does not bind in C# must fail the
        // stage, not be silently skipped as "translation pending" nor proceed
        // to translate.
        if (project.WorkspaceLoadFailed)
        {
            return TranslatedProject.LoadFailed(project.WorkspaceLoadErrors);
        }

        var files = new List<GsharpSourceFile>();
        var usedGsFileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Issue #2292: ONE translator instance shared across every document in
        // this project (rather than a fresh one per file) so its package-scoped
        // anonymous-type registry (see `CSharpToGSharpTranslator.
        // anonymousTypeRegistriesByPackage`) is shared too — otherwise two
        // files in the same package could each mint a colliding
        // `AnonymousTypeN` name for two DIFFERENT anonymous shapes (GS0102).
        var translator = new CSharpToGSharpTranslator();
        foreach (LoadedDocument document in project.Documents)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var translationContext = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);

            CompilationUnit unit = translator.TranslateDocument(document, translationContext);
            string printed = GSharpPrinter.Print(unit);

            TranslationDiagnostic unsupported = translationContext.Diagnostics
                .FirstOrDefault(d => d.Severity == TranslationSeverity.Unsupported);
            if (unsupported is not null)
            {
                return TranslatedProject.Pending(
                    $"test-translation pending map-advanced — unsupported C# construct " +
                    $"'{unsupported.ConstructKind}' in {Path.GetFileName(document.FilePath)}: {unsupported.Message}");
            }

            RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
            if (!roundTrip.Success)
            {
                return TranslatedProject.Pending(
                    $"test-translation pending map-advanced — emitted G# for " +
                    $"{Path.GetFileName(document.FilePath)} did not round-trip-parse: " +
                    (roundTrip.Errors.FirstOrDefault() ?? "unknown parse error"));
            }

            string gsFileName = EmittedFileNaming.UniqueGsFileName(document.FilePath, usedGsFileNames);
            files.Add(new GsharpSourceFile(gsFileName, printed));
        }

        return TranslatedProject.Ready(files);
    }

    private static (int Exit, string Stdout, string Stderr, bool TimedOut) RunProgram(string assemblyPath, string workingDirectory)
    {
        // The migrated program under test is exactly the code stage 4 exists to
        // scrutinize: a codegen bug can produce an infinite loop, and a
        // translated Console.ReadLine() would otherwise block on inherited
        // stdin. ProcessRunner bounds the run and never inherits stdin (#1748).
        ProcessRunResult result = ProcessRunner.Run(
            "dotnet", new[] { assemblyPath }, workingDirectory, Stage4Timeout());
        return (result.ExitCode, result.Stdout, result.Stderr, result.TimedOut);
    }

    /// <summary>
    /// The stage-4 program-under-test timeout, 30s by default. A legit slow
    /// migrated program on a cold/constrained CI runner can false-positive
    /// against a fixed 30s, so allow an override via
    /// <c>CS2GS_STAGE4_TIMEOUT_SEC</c> (#1817 S1).
    /// </summary>
    private static TimeSpan Stage4Timeout()
    {
        string env = Environment.GetEnvironmentVariable("CS2GS_STAGE4_TIMEOUT_SEC");
        return int.TryParse(env, out int seconds) && seconds > 0
            ? TimeSpan.FromSeconds(seconds)
            : TimeSpan.FromSeconds(30);
    }

    private static string EmittedGsRelative(StageExecutionContext context) =>
        context.EmittedFiles.Count > 0 ? context.EmittedFiles[0].RelativeGsPath : null;

    private static string Truncate(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        string trimmed = value.Trim();
        return trimmed.Length <= 2000 ? trimmed : trimmed.Substring(trimmed.Length - 2000);
    }

    private void Note(StageExecutionContext context, string message)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(context.AppRunDir, "test-parity.log"),
                message + Environment.NewLine);
        }
        catch (IOException)
        {
            // A best-effort diagnostic log; never fail the stage on a log write.
        }
    }

    private sealed class TranslatedProject
    {
        private TranslatedProject(
            IReadOnlyList<GsharpSourceFile> files,
            string pendingReason,
            IReadOnlyList<Diagnostic> loadErrors)
        {
            this.Files = files ?? Array.Empty<GsharpSourceFile>();
            this.PendingReason = pendingReason;
            this.LoadErrors = loadErrors;
        }

        public IReadOnlyList<GsharpSourceFile> Files { get; }

        public string PendingReason { get; }

        /// <summary>Gets the load-error diagnostics, or <see langword="null"/> if the project bound.</summary>
        public IReadOnlyList<Diagnostic> LoadErrors { get; }

        public static TranslatedProject Ready(IReadOnlyList<GsharpSourceFile> files) =>
            new TranslatedProject(files, null, null);

        public static TranslatedProject Pending(string reason) =>
            new TranslatedProject(Array.Empty<GsharpSourceFile>(), reason, null);

        public static TranslatedProject LoadFailed(IReadOnlyList<Diagnostic> loadErrors) =>
            new TranslatedProject(Array.Empty<GsharpSourceFile>(), null, loadErrors);
    }
}

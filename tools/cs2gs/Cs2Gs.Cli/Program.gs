// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Cli

import Cs2Gs.Pipeline
import Cs2Gs.Report
import Cs2Gs.Translator
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks

/// Entry point for the `cs2gs` command-line tool. Exposes the
/// `migrate` verb that drives the (cref:MigrationPipeline) over a
/// C# corpus, writing triage artifacts and a run summary, and prints a
/// per-app × per-stage status matrix (ADR-0115 §C/§D/§F); plus a `report`
/// verb that regenerates the §F `report.html` + `summary.json` from an
/// existing `run.json` without re-running the pipeline.
internal shared class Program {
    /// The parsed `migrate` command line.
    /// @param Corpus The source repository root.
    /// @param AppIds Explicit `--app` ids (diagnostic runs only).
    /// @param Options The pipeline options.
    /// @param BaselinePath The gap-ledger path, or `null`.
    /// @param BaselineStrict Whether stale ledger entries fail the gate.
    /// @param TranslateOnly Whether to run the translate stage only (issue #3668).
    /// @param AllowListPath An explicit test-parity allow-list path, or `null` (issue #3885).
    /// @param StopAfter The last stage to run, or `null` for all stages (issue #4853).
    private data struct MigrateArguments(
        Corpus string?,
        AppIds List[string],
        Options PipelineOptions,
        BaselinePath string?,
        BaselineStrict bool,
        TranslateOnly bool,
        AllowListPath string?,
        StopAfter MigrationStageKind?
    ) : IEquatable[MigrateArguments] { }

    /// Sentinel exception thrown by (cref:NextValue) when an option's
    /// value is missing, so verb loops can catch exactly this case as a usage
    /// error without also catching unrelated (cref:ArgumentException)s.
    private class MissingOptionValueException : ArgumentException {
        init(message string) : base(message) { }
    }

    /// Parses the command line and dispatches to a verb.
    /// @param args The command-line arguments.
    /// @returns The process exit code: 0 when the run (and, for `migrate`, its
    /// report) succeeded, 1 when the run itself found failures/gaps, and 2
    /// when the tool errored — including when the report could not be
    /// generated at all, which must never be masked as a clean exit 0.
    internal async func Main(args[]string) int32 {
        if args.Length == 0 {
            PrintUsage()
            return 1
        }
        let verb = args[0]
        if verb == "-h" || verb == "--help" || verb == "help" {
            PrintUsage()
            return 0
        }
        if verb == "migrate" || verb == "run" {
            try {
                return await RunMigrateAsync(args.Skip(1).ToArray()).ConfigureAwait(false)
            } catch (ex Exception) {
                Console.Error.WriteLine("cs2gs: " + ex.Message)
                return 2
            }
        }
        if verb == "validate" {
            try {
                return await ValidateCommand.RunAsync(args.Skip(1).ToArray()).ConfigureAwait(false)
            } catch (ex Exception) {
                Console.Error.WriteLine("cs2gs: " + ex.Message)
                return 2
            }
        }
        if verb == "capture-test-oracle" {
            try {
                return CaptureTestOracleCommand.Run(args.Skip(1).ToArray())
            } catch (ex Exception) {
                Console.Error.WriteLine("cs2gs: " + ex.Message)
                return 2
            }
        }
        if verb == "report" {
            try {
                return RunReport(args.Skip(1).ToArray())
            } catch (ex Exception) {
                Console.Error.WriteLine("cs2gs: " + ex.Message)
                return 2
            }
        }
        if verb == "coverage" {
            try {
                return CoverageCommand.Run(args.Skip(1).ToArray())
            } catch (ex Exception) {
                Console.Error.WriteLine("cs2gs: " + ex.Message)
                return 2
            }
        }
        if verb == "triage" {
            try {
                return TriageCommand.Run(args.Skip(1).ToArray())
            } catch (ex Exception) {
                Console.Error.WriteLine("cs2gs: " + ex.Message)
                return 2
            }
        }
        Console.Error.WriteLine("cs2gs: unknown command '$verb'.")
        PrintUsage()
        return 1
    }

    /// Combines the migration outcome with whether the report was actually
    /// written into the process exit code. Report-generation failure always
    /// wins (exit 2), regardless of whether every app migrated cleanly — a
    /// broken/missing report must never look like a clean exit 0, and must be
    /// distinguishable from "migration ran and found gaps" (exit 1).
    /// @param runSucceeded Whether every app passed every pipeline stage.
    /// @param reportGenerated Whether `report.html`/`summary.json` were written.
    /// @returns 0 when the run and the report both succeeded; 2 when the report failed; otherwise 1.
    internal func DetermineMigrateExitCode(runSucceeded bool, reportGenerated bool) int32 {
        if !reportGenerated {
            return 2
        }
        return if runSucceeded {
            0
        } else {
            1
        }
    }

    /// Regenerates `report.html` + `summary.json` for the just-completed
    /// run. Failures here (a malformed triage artifact, a full disk, a missing
    /// `run.json`, etc.) are logged to stderr and reported back to the caller
    /// rather than swallowed, so (cref:RunMigrateAsync) can turn them into a
    /// non-zero exit code — a broken report must never look like a clean exit 0.
    /// @param runDir The run directory to build the report from.
    /// @returns `true` when both artifacts were written; otherwise `false`.
    internal func GenerateReport(runDir string) bool {
        try {
            let model = ReportModel.FromRunDirectory(runDir)
            let htmlPath = HtmlReportWriter.Write(model, runDir)
            let jsonPath = JsonSummaryWriter.Write(model, runDir)
            Console.WriteLine()
            Console.WriteLine("report:  $htmlPath")
            Console.WriteLine("summary: $jsonPath")
            return true
        } catch (ex Exception) {
            Console.Error.WriteLine("cs2gs: failed to generate report: " + ex.Message)
            return false
        }
    }

    /// Prints the per-app × per-stage status matrix and the green-count verdict.
    /// Shared by `migrate` and `validate` so a shard's log reads
    /// exactly like a whole run's.
    /// @param result The (possibly partial) run result.
    /// @param stages The stages the run executed, in order.
    /// @param verb The verb to label the run with (`migrate` or `validate`).
    internal func PrintSummary(result RunResult, stages IReadOnlyList[IMigrationStage], verb string = "migrate") {
        let stageNames = stages.Select((s IMigrationStage) -> TriageSerialization.StageName(s.Kind)).ToList()
        Console.WriteLine()
        Console.WriteLine("cs2gs $verb — run ${result.RunId}")
        Console.WriteLine("gsc: ${result.GscVersion}")
        Console.WriteLine()
        let idWidth = Math.Max(3, result.Apps.Select((a AppResult) -> a.AppId.Length).DefaultIfEmpty(3).Max())
        let header = "app".PadRight(idWidth) + "  " + string.Join("  ", stageNames.Select((n string) -> n.PadRight(12)))
        Console.WriteLine(header)
        Console.WriteLine(String('-', header.Length))
        for app in result.Apps {
            let cells = List[string]()
            for stageName in stageNames {
                let stage StageResult? = app.Stages.FirstOrDefault((s StageResult) -> s.Stage == stageName)
                cells.Add(FormatCell(stage).PadRight(12))
            }
            Console.WriteLine(app.AppId.PadRight(idWidth) + "  " + string.Join("  ", cells))
            if !app.Succeeded {
                for artifact in app.Artifacts {
                    Console.WriteLine("    -> ${app.FailureCategory}: $artifact")
                }
            }
            // Issue #3885 requirement 3: an app that is green ONLY because of
            // the test-parity allow-list must say so in the same place its
            // verdict is printed. An allow-list that is invisible on a passing
            // run is the dangerous kind.
            for allowed in app.AllowedTestFailures {
                Console.WriteLine("    ~> allow-listed test failure: $allowed")
            }
            for stale in app.StaleAllowListEntries {
                Console.WriteLine("    ~> allow-list entry no longer failing — remove from the allow-list: $stale")
            }
        }
        Console.WriteLine()
        // Same precedence as the report (issue #1831): a run-level failure
        // always wins; otherwise call out unverified apps rather than
        // rendering them as a plain pass.
        let passed = result.Apps.Count((a AppResult) -> a.Succeeded && !a.Unverified)
        let unverified = result.Apps.Count((a AppResult) -> a.Unverified)
        let verdict = if !result.Succeeded {
            "FAILED"
        } else {
            (
                if unverified > 0 {
                    "PASSED ($unverified unverified)"
                } else {
                    "PASSED"
                }
            )
        }
        Console.WriteLine("$passed/${result.Apps.Count} apps green; run $verdict.")
    }

    private async func RunMigrateAsync(args[]string) int32 {
        let parsed = ParseMigrateArgs(args, out var helpRequested)
        if parsed == nil {
            return if helpRequested {
                0
            } else {
                1
            }
        }
        var (corpus, appIds, options, baselinePath, baselineStrict, translateOnly, allowListPath, stopAfter) = parsed
        // Issue #3732: canonicalize, not merely absolutize. A root reached
        // through a symlink (`/tmp` and `$TMPDIR` are both links on macOS)
        // splits every mirrored project's NuGet identity between the link
        // spelling and the real one, restore drops the ProjectReference
        // closure, and gsc dies with GS9997 on the first transitively-reached
        // package assembly it needs. See CanonicalRootPath.
        options.SourceRoot = CanonicalRootPath.Resolve(corpus)
        corpus = options.SourceRoot
        options.OutputRoot = CanonicalRootPath.Resolve(options.OutputRoot)
        options.ArtifactRoot = CanonicalRootPath.Resolve(options.ArtifactRoot)
        // Issue #3885: the test-parity failure allow-list, read from the source
        // repository. A malformed list stops the run here — degrading to "allow
        // nothing" would surface as an unrelated wall of parity failures.
        try {
            options.TestParityAllowList = TestParityAllowList.LoadForRepository(options.SourceRoot, allowListPath)
            // The default baseline only matters when per-name parity runs.
            if options.TestNameParityBaseline == nil && !string.IsNullOrEmpty(options.CSharpTestOracleDirectory) {
                options.TestNameParityBaseline = TestNameParityBaseline.LoadForRepository(options.SourceRoot, nil)
            }
        } catch (ex Exception) when ex is InvalidOperationException || ex is IOException {
            Console.Error.WriteLine("cs2gs: " + ex.Message)
            return 1
        }
        var apps IReadOnlyList[CorpusApp]
        if options.OutputLayout == MigrationOutputLayout.Repository {
            if appIds.Count > 0 {
                Console.Error.WriteLine("cs2gs: --app is available only with --diagnostic-run.")
                return 1
            }
            if !string.IsNullOrEmpty(baselinePath) || baselineStrict {
                Console.Error.WriteLine(
                    "cs2gs: --baseline and --baseline-strict are available only with --diagnostic-run."
                )
                return 1
            }
            if string.IsNullOrWhiteSpace(options.OutputRoot) {
                Console.Error.WriteLine("cs2gs: repository migration requires --out <empty-destination>.")
                return 1
            }
            options.ArtifactRoot ??= options.OutputRoot + ".cs2gs-runs"
            apps = RepositoryDiscovery.Discover(corpus)
            if options.ExcludeAppIdPrefixes.Count > 0 || options.PassthroughAppIdPrefixes.Count > 0 {
                let before = apps.Count
                let kept = List[CorpusApp](apps.Count)
                for app in apps {
                    let passthrough = options.PassthroughAppIdPrefixes.Any(
                        (prefix string) -> app.Id.StartsWith(prefix, StringComparison.Ordinal)
                    )
                    let excluded = passthrough || options.ExcludeAppIdPrefixes.Any(
                        (prefix string) -> app.Id.StartsWith(prefix, StringComparison.Ordinal)
                    )
                    if excluded {
                        // Issue #3580: the orphan-mirror step must know which
                        // projects left the run via --exclude — the sources
                        // they compile are out of scope, not repository
                        // orphans.
                        options.ExcludedProjectPaths.Add(app.ProjectPath)
                        if passthrough {
                            options.PassthroughProjectPaths.Add(app.ProjectPath)
                        }
                    } else {
                        kept.Add(app)
                    }
                }
                apps = kept
                Console.WriteLine("cs2gs: excluded ${before - apps.Count} project(s) via --exclude/--passthrough.")
            }
        } else if appIds.Count > 0 {
            let selected = List[CorpusApp]()
            for id in appIds {
                let app CorpusApp? = CorpusDiscovery.FindById(corpus, id)
                if app == nil {
                    Console.Error.WriteLine("cs2gs: corpus app '$id' not found under $corpus.")
                    return 1
                }
                selected.Add(app)
            }
            apps = selected
        } else {
            apps = CorpusDiscovery.Discover(corpus)
        }
        if apps.Count == 0 {
            Console.Error.WriteLine("cs2gs: no corpus apps discovered under $corpus.")
            return 1
        }
        if translateOnly && options.OutputLayout != MigrationOutputLayout.Repository {
            Console.Error.WriteLine("cs2gs: --translate-only applies to repository migration only.")
            return 1
        }
        // Issue #3668: --translate-only keeps the whole-repository translate
        // pass (and its cross-project linked-source guard) intact while
        // deferring the per-app compile/ilverify/test-parity work to
        // `cs2gs validate` shards.
        //
        // Issue #4853: --stop-after <stage> runs every stage up to and
        // including <stage>, so a cut-over rehearsal can stop after compile
        // (which carries the redundant-!! polish) without paying for test
        // parity. --translate-only is --stop-after translate.
        let lastStage = if translateOnly {
            MigrationStageKind.Translate
        } else {
            stopAfter
        }
        // --translate-only keeps its documented contract (validate shards run the
        // rest); an explicit --stop-after before test-parity is a partial run.
        options.PartialRun = !translateOnly &&
            stopAfter is MigrationStageKind early &&
            early != MigrationStageKind.TestParity
        let pipeline = if lastStage is MigrationStageKind last {
            MigrationPipeline(options, MigrationPipeline.StagesThrough(last))
        } else {
            MigrationPipeline(options)
        }
        let result = await pipeline.RunAsync(apps).ConfigureAwait(false)
        PrintSummary(result, pipeline.Stages)
        if !translateOnly && stopAfter is MigrationStageKind partial && partial != MigrationStageKind.TestParity {
            Console.WriteLine(
                "cs2gs: partial run (--stop-after ${TriageSerialization.StageName(partial)}): the later stages were not " +
                    "run, so green here is not a full verdict."
            )
        }
        let runsRoot string? = if options.OutputLayout == MigrationOutputLayout.Repository {
            options.ArtifactRoot
        } else {
            options.OutputRoot
        }
        let runDir = ResolveRunDir(runsRoot, result.RunId)
        let reportGenerated = GenerateReport(runDir)
        // ADR-0138: with --baseline, the exit gate is the ledger classification
        // (fail on NEW or REGRESSED fingerprints; known-open gaps are tolerated;
        // --baseline-strict additionally fails on STALE entries so the nightly
        // keeps the ledger honest). Without --baseline, today's contract holds.
        if !string.IsNullOrEmpty(baselinePath) {
            let ledger = GapLedger.Load(baselinePath)
            let artifacts = GapLedger.LoadRunArtifacts(runDir)
            let classification = ledger.Classify(artifacts, fullCorpus: appIds.Count == 0)
            PrintBaselineClassification(classification, baselineStrict)
            // A skipped/unverified stage produces NO triage artifact, so a
            // fingerprint-only gate would render such an app green (the issue
            // #1831 class). Unverified apps must be explicitly acknowledged in
            // the ledger's unverifiedApps list to pass.
            let unacknowledged = result
                .Apps
                .Where((a AppResult) -> a.Unverified && !ledger.UnverifiedApps!!.Contains(a.AppId))
                .Select((a AppResult) -> a.AppId)
                .ToList()
            for appId in unacknowledged {
                Console.WriteLine(
                    "  UNVERIFIED $appId — a stage skipped without a triage artifact and the " +
                        "app is not acknowledged in the ledger's unverifiedApps list."
                )
            }
            let gatePassed = classification.PassesGate &&
                unacknowledged.Count == 0 &&
                (!baselineStrict || classification.Stale.Count == 0)
            return DetermineMigrateExitCode(gatePassed, reportGenerated)
        }
        return DetermineMigrateExitCode(result.Succeeded, reportGenerated)
    }

    /// Prints the baseline-gate classification of the run's fingerprints.
    /// @param classification The ledger classification.
    /// @param strict Whether stale entries fail the gate (nightly mode).
    private func PrintBaselineClassification(classification BaselineClassification, strict bool) {
        Console.WriteLine()
        Console.WriteLine(
            "baseline: ${classification.Known.Count} known, ${classification.New.Count} new, " +
                "${classification.Regressed.Count} regressed, ${classification.Stale.Count} stale."
        )
        for artifact in classification.New {
            Console.WriteLine(
                "  NEW       ${artifact.Fingerprint} ${artifact.Stage} " +
                    "${artifact.Diagnostic?.Id} ${artifact.OffendingCSharpConstruct?.Kind} (${artifact.CorpusAppId})"
            )
        }
        for artifact in classification.Regressed {
            Console.WriteLine(
                "  REGRESSED ${artifact.Fingerprint} ${artifact.Stage} " +
                    "${artifact.Diagnostic?.Id} (${artifact.CorpusAppId}) — ledgered as resolved"
            )
        }
        for entry in classification.Stale {
            let verdict = if strict {
                "FAIL (strict)"
            } else {
                "warn"
            }
            Console.WriteLine(
                "  STALE     ${entry.Fingerprint} #${entry.Issue} — open in the ledger but " +
                    "not reproduced ($verdict); resolve or prune via `cs2gs triage sync`."
            )
        }
    }

    private func RunReport(args[]string) int32 {
        var runDir string? = nil
        var outPath string? = nil
        try {
            for var i = 0; i < args.Length; i++ {
                let arg = args[i]
                switch arg {
                    case "-h", "--help" {
                        PrintUsage()
                        return 0
                    }
                    case "--run" {
                        runDir = NextValue(args, &i, arg)
                    }
                    case "--out" {
                        outPath = NextValue(args, &i, arg)
                    }
                    default {
                        Console.Error.WriteLine("cs2gs: unknown option '$arg'.")
                        PrintUsage()
                        return 1
                    }
                }
            }
        } catch (ex MissingOptionValueException) {
            Console.Error.WriteLine("cs2gs: " + ex.Message)
            PrintUsage()
            return 1
        }
        if string.IsNullOrEmpty(runDir) {
            Console.Error.WriteLine("cs2gs: report requires --run <runDir> (a directory containing run.json).")
            return 1
        }
        runDir = Path.GetFullPath(runDir)
        if !File.Exists(Path.Combine(runDir, "run.json")) {
            Console.Error.WriteLine("cs2gs: no run.json found under $runDir.")
            return 1
        }
        var targetDir string? = runDir
        var htmlFileName string? = nil
        var jsonFileName string? = nil
        if !string.IsNullOrEmpty(outPath) {
            targetDir, htmlFileName, jsonFileName = ResolveOutTarget(outPath)
            Directory.CreateDirectory(targetDir!!)
        }
        let model = ReportModel.FromRunDirectory(runDir)
        let htmlPath = HtmlReportWriter.Write(model, targetDir, htmlFileName)
        let jsonPath = JsonSummaryWriter.Write(model, targetDir, jsonFileName)
        Console.WriteLine("report:  $htmlPath")
        Console.WriteLine("summary: $jsonPath")
        return 0
    }

    /// Decides whether a user-supplied `--out <file-or-dir>` path names
    /// a directory or a specific output file, and resolves it to a
    /// (targetDir, htmlFileName, jsonFileName) triple. The rule, in order:
    /// 1. A path ending in a directory separator is always a directory.
    /// 2. An existing directory is a directory.
    /// 3. An existing file is that exact file (its parent is the target dir).
    /// 4. A non-existent path whose extension is a recognized report extension (`.html`, `.htm`, `.json`)
    /// is a to-be-created file with that name.
    /// 5. Anything else (no extension, or an unrecognized/dotted name such as `run.2026-07-01`) is a
    /// to-be-created directory.
    /// When resolved as a file, the file's own extension picks which artifact
    /// it renames (`.json` renames `summary.json`; anything else
    /// renames `report.html`); the other artifact keeps its default name
    /// in the same directory, since one `--out` file name cannot cover two
    /// distinct output artifacts.
    /// @param outPath The raw `--out` value.
    /// @returns The resolved target directory and optional per-writer file names.
    private func ResolveOutTarget(outPath string?)(TargetDir string?, HtmlFileName string?, JsonFileName string?) {
        let trailingSeparator = outPath!!.EndsWith(Path.DirectorySeparatorChar) || outPath!!.EndsWith(
            Path.AltDirectorySeparatorChar
        )
        let fullPath = Path.GetFullPath(outPath!!)
        let isDirectory = trailingSeparator || Directory.Exists(fullPath) ||
            (!File.Exists(fullPath) && !IsRecognizedReportExtension(fullPath))
        if isDirectory {
            return (fullPath, nil, nil)
        }
        let targetDir string? = Path.GetDirectoryName(fullPath)
        let fileName = Path.GetFileName(fullPath)
        let isJson = string.Equals(Path.GetExtension(fileName), ".json", StringComparison.OrdinalIgnoreCase)
        return if isJson {
            (targetDir, nil, fileName)
        } else {
            (targetDir, fileName, nil)
        }
    }

    private func IsRecognizedReportExtension(path string) bool {
        let extension = Path.GetExtension(path)
        return string.Equals(extension, ".html", StringComparison.OrdinalIgnoreCase) || string.Equals(
            extension,
            ".htm",
            StringComparison.OrdinalIgnoreCase
        ) ||
            string.Equals(extension, ".json", StringComparison.OrdinalIgnoreCase)
    }

    private func ResolveRunDir(outputRoot string?, runId string) string {
        let root = Path.GetFullPath(outputRoot ?? Path.Combine(Directory.GetCurrentDirectory(), "cs2gs-runs"))
        return Path.Combine(root, runId)
    }

    private func ParseMigrateArgs(args[]string, out helpRequested bool) MigrateArguments? {
        helpRequested = false
        var corpus string? = nil
        var baselinePath string? = nil
        var allowListPath string? = nil
        var baselineStrict = false
        var translateOnly = false
        var stopAfter MigrationStageKind? = nil
        var sdkPinSpecified = false
        let appIds = List[string]()
        let options = PipelineOptions{OutputLayout: MigrationOutputLayout.Repository}
        for var i = 0; i < args.Length; i++ {
            let arg = args[i]
            try {
                switch arg {
                    case "-h", "--help" {
                        helpRequested = true
                        PrintUsage()
                        return nil
                    }
                    case "--corpus" {
                        corpus = NextValue(args, &i, arg)
                    }
                    case "--app" {
                        appIds.Add(NextValue(args, &i, arg))
                    }
                    case "--gsc" {
                        options.GscPath = NextValue(args, &i, arg)
                    }
                    case "--gsgen" {
                        options.GsgenPath = NextValue(args, &i, arg)
                    }
                    case "--out" {
                        options.OutputRoot = NextValue(args, &i, arg)
                    }
                    case "--artifacts" {
                        options.ArtifactRoot = NextValue(args, &i, arg)
                    }
                    case "--diagnostic-run" {
                        options.OutputLayout = MigrationOutputLayout.DiagnosticRun
                    }
                    case "--config" {
                        options.Config = NextValue(args, &i, arg)
                    }
                    case "--exclude" {
                        options.ExcludeAppIdPrefixes.Add(NextValue(args, &i, arg).Replace('\\', '/').TrimEnd('/'))
                    }
                    case "--passthrough" {
                        options.PassthroughAppIdPrefixes.Add(NextValue(args, &i, arg).Replace('\\', '/').TrimEnd('/'))
                    }
                    case "--baseline" {
                        baselinePath = NextValue(args, &i, arg)
                    }
                    case "--test-allowlist" {
                        allowListPath = NextValue(args, &i, arg)
                    }
                    case "--csharp-test-oracle" {
                        options.CSharpTestOracleDirectory = Path.GetFullPath(NextValue(args, &i, arg))
                    }
                    case "--test-name-baseline" {
                        options.TestNameParityBaseline = TestNameParityBaseline.Load(
                            Path.GetFullPath(NextValue(args, &i, arg))
                        )
                    }
                    case "--baseline-strict" {
                        baselineStrict = true
                    }
                    case "--translate-only" {
                        translateOnly = true
                    }
                    case "--stop-after" {
                        let stopAfterName = NextValue(args, &i, arg)
                        if !TriageSerialization.TryParseStageName(stopAfterName, out var stopAfterKind) {
                            Console.Error.WriteLine(
                                "cs2gs: --stop-after expects 'translate', 'compile', 'ilverify' or 'test-parity', not '$stopAfterName'."
                            )
                            return nil
                        }
                        stopAfter = stopAfterKind
                    }
                    case "--format" {
                        options.FormatOutput = true
                    }
                    case "--no-format" {
                        options.FormatOutput = false
                    }
                    case "--via-sdk" {
                        options.CompileViaSdk = true
                    }
                    case "--no-via-sdk" {
                        options.CompileViaSdk = false
                    }
                    case "--allow-conditional-compilation" {
                        options.ConditionalCompilation = ConditionalCompilationPolicy.Warn
                    }
                    case "--sdk-version" {
                        options.SdkVersion = NextValue(args, &i, arg)
                        if !SdkPinArguments.IsValidVersion(options.SdkVersion) {
                            Console.Error.WriteLine(
                                "cs2gs: --sdk-version expects a version such as 0.4.1200, not '${options.SdkVersion}'."
                            )
                            return nil
                        }
                    }
                    case "--sdk-pin" {
                        sdkPinSpecified = true
                        let pin = NextValue(args, &i, arg)
                        if !SdkPinArguments.TryParseLocation(pin, out var location) {
                            Console.Error.WriteLine("cs2gs: --sdk-pin expects 'project' or 'global-json', not '$pin'.")
                            return nil
                        }
                        options.SdkPinLocation = location
                    }
                    default {
                        Console.Error.WriteLine("cs2gs: unknown option '$arg'.")
                        PrintUsage()
                        return nil
                    }
                }
            } catch (ex MissingOptionValueException) {
                Console.Error.WriteLine("cs2gs: " + ex.Message)
                PrintUsage()
                return nil
            }
        }
        if options.OutputLayout == MigrationOutputLayout.DiagnosticRun &&
            (options.SdkVersion != nil || sdkPinSpecified) {
            Console.Error.WriteLine("cs2gs: --sdk-version and --sdk-pin apply to repository migration only.")
            return nil
        }
        if translateOnly && stopAfter is MigrationStageKind requested && requested != MigrationStageKind.Translate {
            Console.Error.WriteLine(
                "cs2gs: --translate-only is --stop-after translate and conflicts with " +
                    "--stop-after ${TriageSerialization.StageName(requested)}; pass only one."
            )
            return nil
        }
        if string.IsNullOrEmpty(corpus) {
            corpus = DefaultCorpus()
            if corpus == nil {
                Console.Error.WriteLine("cs2gs: --corpus <dir> is required (no default corpus found).")
                return nil
            }
        }
        return MigrateArguments(
            corpus,
            appIds,
            options,
            baselinePath,
            baselineStrict,
            translateOnly,
            allowListPath,
            stopAfter
        )
    }

    /// Reads the value following an option flag (e.g. `--gsc <path>`).
    /// @exception MissingOptionValueException The flag was the last token with no value following it.
    /// Callers catch
    /// this specific type and route it through the print-usage/return-1 path —
    /// a missing value is a usage error, not an internal error. Using a
    /// dedicated sentinel (rather than the base (cref:ArgumentException))
    /// keeps that catch from also swallowing an unrelated
    /// (cref:ArgumentException) thrown by a case body (e.g. a future
    /// validating option setter), which must still escape to (cref:Main)'s
    /// generic catch (exit code 2).
    private func NextValue(args[]string, ref index int32, flag string) string {
        if index + 1 >= args.Length {
            throw MissingOptionValueException("option '$flag' requires a value.")
        }
        return args[(index += 1)]
    }

    private func DefaultCorpus() string? {
        var dir DirectoryInfo? = DirectoryInfo(Directory.GetCurrentDirectory())
        while dir != nil {
            let candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus")
            if Directory.Exists(candidate) {
                return candidate
            }
            dir = dir.Parent
        }
        return nil
    }

    private func FormatCell(stage StageResult?) string {
        if stage == nil {
            return "-"
        }
        return switch stage.Status {
            case "passed": "PASS"
            case "failed": "FAIL(${stage.ArtifactCount})"
            case "skipped": "skip"
            default: stage.Status
        }
    }

    private func PrintUsage() {
        Console.WriteLine("cs2gs - C# to G# migration tool (ADR-0115)")
        Console.WriteLine()
        Console.WriteLine("Usage:")
        Console.WriteLine("  cs2gs migrate [options]")
        Console.WriteLine("  cs2gs validate --corpus <repo-root> --migrated <dir> [--shard i/N | --app <id>...]")
        Console.WriteLine("  cs2gs capture-test-oracle --corpus <repo-root> --out <dir> [--exclude <path>...]")
        Console.WriteLine("  cs2gs report --run <runDir> [--out <file-or-dir>]")
        Console.WriteLine("  cs2gs coverage [--write] [--repo-root <dir>]")
        Console.WriteLine("  cs2gs triage list --run <runDir> [--gaps <file>]")
        Console.WriteLine(
            "  cs2gs triage file-issues --run <runDir> [--gaps <file>] [--file] [--limit N] [--milestone M]"
        )
        Console.WriteLine("  cs2gs triage sync [--gaps <file>] [--write] [--no-test-reason <why>]")
        Console.WriteLine()
        Console.WriteLine("migrate options:")
        Console.WriteLine("  --corpus <dir>    Source repository root (default: tools/cs2gs/corpus).")
        Console.WriteLine("  --out <dir>       Empty destination repository (required by default).")
        Console.WriteLine("  --artifacts <dir> Validation runs root (default: <out>.cs2gs-runs).")
        Console.WriteLine("  --diagnostic-run  Preserve the historical timestamped corpus/CI layout.")
        Console.WriteLine("  --app <id>        Diagnostic-run only; migrate one app (repeatable).")
        Console.WriteLine("  --gsc <path>      Override gsc.dll (default: out/bin/<Config>/Compiler/gsc.dll).")
        Console.WriteLine(
            "  --gsgen <path>    Override gsgen.dll (default: out/bin/<Config>/Gsgen.Cli/gsgen.dll); issue #2215."
        )
        Console.WriteLine("                    With --diagnostic-run, --out is the runs root.")
        Console.WriteLine("  --config <name>   Build config used to find gsc (default: Release).")
        Console.WriteLine("  --exclude <path>  Repository migration only: exclude apps whose repo-relative id")
        Console.WriteLine("                    starts with <path> (repeatable; e2e fixtures, non-app projects).")
        Console.WriteLine("  --passthrough <path>  Repository migration only: exclude matching apps from")
        Console.WriteLine("                    translation but preserve their original C# project and sources.")
        Console.WriteLine("  --baseline <file> Gate on the gap ledger (tools/cs2gs/triage/gaps.json): fail only on")
        Console.WriteLine("                    NEW or REGRESSED fingerprints; known-open gaps are tolerated.")
        Console.WriteLine("  --baseline-strict Also fail on STALE ledger entries (nightly mode).")
        Console.WriteLine("  --test-allowlist <file>  Test-parity failure allow-list (issue #3885); default:")
        Console.WriteLine("                    <corpus>/" + TestParityAllowList.DefaultRelativePath + " when present.")
        Console.WriteLine("  --csharp-test-oracle <dir>  Check mirrored test projects name for name against the")
        Console.WriteLine("                    C# case lists `cs2gs capture-test-oracle` wrote (issue #4633); the")
        Console.WriteLine(
            "                    justified differences are read from <corpus>/" +
                TestNameParityBaseline.DefaultRelativePath
        )
        Console.WriteLine("  --test-name-baseline <file>  Use this per-test-name baseline instead of the default.")
        Console.WriteLine("  --via-sdk         Build emitted G# via 'dotnet build' + Gsharp.NET.Sdk (default).")
        Console.WriteLine("  --no-via-sdk      Use the legacy direct-gsc compile path.")
        Console.WriteLine("  --allow-conditional-compilation  Report each C# #if/#elif as a non-fatal")
        Console.WriteLine("                    CS2GS-CONDITIONAL-COMPILATION warning and translate the active arm,")
        Console.WriteLine("                    instead of failing translation. Only for a pinned external corpus")
        Console.WriteLine("                    that cannot be edited; G# has no conditional compilation.")
        Console.WriteLine("                    Applies to the Translate stage only: test-parity, orphan-source")
        Console.WriteLine("                    and analyzer-snippet translation still reject #if.")
        Console.WriteLine("  --translate-only  Repository migration only (issue #3668): run stage 1 across the WHOLE")
        Console.WriteLine("                    repository and stop, writing a per-app validation-context.json so")
        Console.WriteLine("                    'cs2gs validate' shards can run stages 2-4 in parallel elsewhere.")
        Console.WriteLine("  --stop-after <s>  Run the stages up to and including <s> (translate, compile, ilverify or")
        Console.WriteLine("                    test-parity; default test-parity). 'compile' includes the redundant-!!")
        Console.WriteLine("                    polish, so the migrated tree is final without running test parity")
        Console.WriteLine("                    (issue #4853). --translate-only selects the same stages as")
        Console.WriteLine("                    --stop-after translate but does not mark apps unverified.")
        Console.WriteLine("  --sdk-version <v> Repository migration only: pin Gsharp.NET.Sdk to exactly <v> (default:")
        Console.WriteLine("                    the newest local nupkg). A local nupkg of <v> is staged into .nugs;")
        Console.WriteLine("                    otherwise <v> must be on nuget.org (e.g. a published release).")
        Console.WriteLine("  --sdk-pin <where> Repository migration only: 'project' (default) writes the version into")
        Console.WriteLine("                    every generated project's Sdk declaration; 'global-json' writes it")
        Console.WriteLine("                    under msbuild-sdks in the root and nested global.json files")
        Console.WriteLine("                    and keeps Gsharp.NET.Sdk declarations unversioned.")
        Console.WriteLine("  --format          Run the ADR-0179 gsfmt post-pass (default).")
        Console.WriteLine("  --no-format       Keep the printer layout instead (A/B measurement only).")
        Console.WriteLine()
        Console.WriteLine("validate options: run 'cs2gs validate --help'.")
        Console.WriteLine()
        Console.WriteLine("report options:")
        Console.WriteLine("  --run <dir>       Existing run directory containing run.json (required).")
        Console.WriteLine("  --out <file-or-dir>")
        Console.WriteLine("                    Output location for report.html + summary.json (default: the run dir).")
        Console.WriteLine("                    A trailing slash or an existing directory is always a directory.")
        Console.WriteLine("                    A path ending in .html/.htm/.json (or an existing file) names that one")
        Console.WriteLine("                    output file directly; the other artifact keeps its default name")
        Console.WriteLine("                    alongside it. Any other path is created as a directory.")
        Console.WriteLine()
        Console.WriteLine("coverage options:")
        Console.WriteLine("  --write           Append skeleton rows for new Roslyn node kinds, canonicalize the")
        Console.WriteLine("                    construct inventory, and regenerate the docs matrix + surface golden.")
        Console.WriteLine("  --repo-root <dir> Repository root (default: walk up from the current directory).")
        Console.WriteLine()
        Console.WriteLine(
            "A migrate run also writes report.html + summary.json into the run dir automatically (ADR-0115 §F)."
        )
        Console.WriteLine()
        Console.WriteLine("Exit code is non-zero if any app fails a stage (so CI can gate).")
    }
}

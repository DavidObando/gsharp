// <copyright file="Program.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Report;

namespace Cs2Gs.Cli;

/// <summary>
/// Entry point for the <c>cs2gs</c> command-line tool. Exposes the
/// <c>migrate</c> verb that drives the <see cref="MigrationPipeline"/> over a
/// C# corpus, writing triage artifacts and a run summary, and prints a
/// per-app × per-stage status matrix (ADR-0115 §C/§D/§F); plus a <c>report</c>
/// verb that regenerates the §F <c>report.html</c> + <c>summary.json</c> from an
/// existing <c>run.json</c> without re-running the pipeline.
/// </summary>
internal static class Program
{
    /// <summary>
    /// Parses the command line and dispatches to a verb.
    /// </summary>
    /// <param name="args">The command-line arguments.</param>
    /// <returns>
    /// The process exit code: 0 when the run (and, for <c>migrate</c>, its
    /// report) succeeded, 1 when the run itself found failures/gaps, and 2
    /// when the tool errored — including when the report could not be
    /// generated at all, which must never be masked as a clean exit 0.
    /// </returns>
    internal static async Task<int> Main(string[] args)
    {
        if (args.Length == 0)
        {
            PrintUsage();
            return 1;
        }

        string verb = args[0];
        if (verb is "-h" or "--help" or "help")
        {
            PrintUsage();
            return 0;
        }

        if (verb is "migrate" or "run")
        {
            try
            {
                return await RunMigrateAsync(args.Skip(1).ToArray()).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("cs2gs: " + ex.Message);
                return 2;
            }
        }

        if (verb is "report")
        {
            try
            {
                return RunReport(args.Skip(1).ToArray());
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("cs2gs: " + ex.Message);
                return 2;
            }
        }

        if (verb is "coverage")
        {
            try
            {
                return CoverageCommand.Run(args.Skip(1).ToArray());
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("cs2gs: " + ex.Message);
                return 2;
            }
        }

        if (verb is "triage")
        {
            try
            {
                return TriageCommand.Run(args.Skip(1).ToArray());
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("cs2gs: " + ex.Message);
                return 2;
            }
        }

        Console.Error.WriteLine($"cs2gs: unknown command '{verb}'.");
        PrintUsage();
        return 1;
    }

    /// <summary>
    /// Combines the migration outcome with whether the report was actually
    /// written into the process exit code. Report-generation failure always
    /// wins (exit 2), regardless of whether every app migrated cleanly — a
    /// broken/missing report must never look like a clean exit 0, and must be
    /// distinguishable from "migration ran and found gaps" (exit 1).
    /// </summary>
    /// <param name="runSucceeded">Whether every app passed every pipeline stage.</param>
    /// <param name="reportGenerated">Whether <c>report.html</c>/<c>summary.json</c> were written.</param>
    /// <returns>0 when the run and the report both succeeded; 2 when the report failed; otherwise 1.</returns>
    internal static int DetermineMigrateExitCode(bool runSucceeded, bool reportGenerated)
    {
        if (!reportGenerated)
        {
            return 2;
        }

        return runSucceeded ? 0 : 1;
    }

    /// <summary>
    /// Regenerates <c>report.html</c> + <c>summary.json</c> for the just-completed
    /// run. Failures here (a malformed triage artifact, a full disk, a missing
    /// <c>run.json</c>, etc.) are logged to stderr and reported back to the caller
    /// rather than swallowed, so <see cref="RunMigrateAsync"/> can turn them into a
    /// non-zero exit code — a broken report must never look like a clean exit 0.
    /// </summary>
    /// <param name="runDir">The run directory to build the report from.</param>
    /// <returns><see langword="true"/> when both artifacts were written; otherwise <see langword="false"/>.</returns>
    internal static bool GenerateReport(string runDir)
    {
        try
        {
            ReportModel model = ReportModel.FromRunDirectory(runDir);
            string htmlPath = HtmlReportWriter.Write(model, runDir);
            string jsonPath = JsonSummaryWriter.Write(model, runDir);
            Console.WriteLine();
            Console.WriteLine($"report:  {htmlPath}");
            Console.WriteLine($"summary: {jsonPath}");
            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("cs2gs: failed to generate report: " + ex.Message);
            return false;
        }
    }

    private static async Task<int> RunMigrateAsync(string[] args)
    {
        (string Corpus, List<string> AppIds, PipelineOptions Options, string BaselinePath, bool BaselineStrict)? parsed = ParseMigrateArgs(args, out bool helpRequested);
        if (parsed is null)
        {
            return helpRequested ? 0 : 1;
        }

        (string corpus, List<string> appIds, PipelineOptions options, string baselinePath, bool baselineStrict) = parsed.Value;
        options.SourceRoot = Path.GetFullPath(corpus);

        IReadOnlyList<CorpusApp> apps;
        if (options.OutputLayout == MigrationOutputLayout.Repository)
        {
            if (appIds.Count > 0)
            {
                Console.Error.WriteLine("cs2gs: --app is available only with --diagnostic-run.");
                return 1;
            }

            if (!string.IsNullOrEmpty(baselinePath) || baselineStrict)
            {
                Console.Error.WriteLine(
                    "cs2gs: --baseline and --baseline-strict are available only with --diagnostic-run.");
                return 1;
            }

            if (string.IsNullOrWhiteSpace(options.OutputRoot))
            {
                Console.Error.WriteLine("cs2gs: repository migration requires --out <empty-destination>.");
                return 1;
            }

            options.ArtifactRoot ??= Path.GetFullPath(options.OutputRoot) + ".cs2gs-runs";
            apps = RepositoryDiscovery.Discover(corpus);
        }
        else if (appIds.Count > 0)
        {
            var selected = new List<CorpusApp>();
            foreach (string id in appIds)
            {
                CorpusApp app = CorpusDiscovery.FindById(corpus, id);
                if (app is null)
                {
                    Console.Error.WriteLine($"cs2gs: corpus app '{id}' not found under {corpus}.");
                    return 1;
                }

                selected.Add(app);
            }

            apps = selected;
        }
        else
        {
            apps = CorpusDiscovery.Discover(corpus);
        }

        if (apps.Count == 0)
        {
            Console.Error.WriteLine($"cs2gs: no corpus apps discovered under {corpus}.");
            return 1;
        }

        var pipeline = new MigrationPipeline(options);
        RunResult result = await pipeline.RunAsync(apps).ConfigureAwait(false);

        PrintSummary(result, pipeline.Stages);

        string runsRoot = options.OutputLayout == MigrationOutputLayout.Repository
            ? options.ArtifactRoot
            : options.OutputRoot;
        string runDir = ResolveRunDir(runsRoot, result.RunId);
        bool reportGenerated = GenerateReport(runDir);

        // ADR-0138: with --baseline, the exit gate is the ledger classification
        // (fail on NEW or REGRESSED fingerprints; known-open gaps are tolerated;
        // --baseline-strict additionally fails on STALE entries so the nightly
        // keeps the ledger honest). Without --baseline, today's contract holds.
        if (!string.IsNullOrEmpty(baselinePath))
        {
            GapLedger ledger = GapLedger.Load(baselinePath);
            IReadOnlyList<TriageArtifact> artifacts = GapLedger.LoadRunArtifacts(runDir);
            BaselineClassification classification = ledger.Classify(artifacts, fullCorpus: appIds.Count == 0);
            PrintBaselineClassification(classification, baselineStrict);

            // A skipped/unverified stage produces NO triage artifact, so a
            // fingerprint-only gate would render such an app green (the issue
            // #1831 class). Unverified apps must be explicitly acknowledged in
            // the ledger's unverifiedApps list to pass.
            List<string> unacknowledged = result.Apps
                .Where(a => a.Unverified && !ledger.UnverifiedApps.Contains(a.AppId))
                .Select(a => a.AppId)
                .ToList();
            foreach (string appId in unacknowledged)
            {
                Console.WriteLine($"  UNVERIFIED {appId} — a stage skipped without a triage artifact and the " +
                    "app is not acknowledged in the ledger's unverifiedApps list.");
            }

            bool gatePassed = classification.PassesGate
                && unacknowledged.Count == 0
                && (!baselineStrict || classification.Stale.Count == 0);
            return DetermineMigrateExitCode(gatePassed, reportGenerated);
        }

        return DetermineMigrateExitCode(result.Succeeded, reportGenerated);
    }

    /// <summary>
    /// Prints the baseline-gate classification of the run's fingerprints.
    /// </summary>
    /// <param name="classification">The ledger classification.</param>
    /// <param name="strict">Whether stale entries fail the gate (nightly mode).</param>
    private static void PrintBaselineClassification(BaselineClassification classification, bool strict)
    {
        Console.WriteLine();
        Console.WriteLine(
            $"baseline: {classification.Known.Count} known, {classification.New.Count} new, " +
            $"{classification.Regressed.Count} regressed, {classification.Stale.Count} stale.");
        foreach (TriageArtifact artifact in classification.New)
        {
            Console.WriteLine($"  NEW       {artifact.Fingerprint} {artifact.Stage} " +
                $"{artifact.Diagnostic?.Id} {artifact.OffendingCSharpConstruct?.Kind} ({artifact.CorpusAppId})");
        }

        foreach (TriageArtifact artifact in classification.Regressed)
        {
            Console.WriteLine($"  REGRESSED {artifact.Fingerprint} {artifact.Stage} " +
                $"{artifact.Diagnostic?.Id} ({artifact.CorpusAppId}) — ledgered as resolved");
        }

        foreach (GapLedgerEntry entry in classification.Stale)
        {
            string verdict = strict ? "FAIL (strict)" : "warn";
            Console.WriteLine($"  STALE     {entry.Fingerprint} #{entry.Issue} — open in the ledger but " +
                $"not reproduced ({verdict}); resolve or prune via `cs2gs triage sync`.");
        }
    }

    private static int RunReport(string[] args)
    {
        string runDir = null;
        string outPath = null;

        try
        {
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                switch (arg)
                {
                    case "-h":
                    case "--help":
                        PrintUsage();
                        return 0;
                    case "--run":
                        runDir = NextValue(args, ref i, arg);
                        break;
                    case "--out":
                        outPath = NextValue(args, ref i, arg);
                        break;
                    default:
                        Console.Error.WriteLine($"cs2gs: unknown option '{arg}'.");
                        PrintUsage();
                        return 1;
                }
            }
        }
        catch (MissingOptionValueException ex)
        {
            Console.Error.WriteLine("cs2gs: " + ex.Message);
            PrintUsage();
            return 1;
        }

        if (string.IsNullOrEmpty(runDir))
        {
            Console.Error.WriteLine("cs2gs: report requires --run <runDir> (a directory containing run.json).");
            return 1;
        }

        runDir = Path.GetFullPath(runDir);
        if (!File.Exists(Path.Combine(runDir, "run.json")))
        {
            Console.Error.WriteLine($"cs2gs: no run.json found under {runDir}.");
            return 1;
        }

        string targetDir = runDir;
        string htmlFileName = null;
        string jsonFileName = null;
        if (!string.IsNullOrEmpty(outPath))
        {
            (targetDir, htmlFileName, jsonFileName) = ResolveOutTarget(outPath);
            Directory.CreateDirectory(targetDir);
        }

        ReportModel model = ReportModel.FromRunDirectory(runDir);
        string htmlPath = HtmlReportWriter.Write(model, targetDir, htmlFileName);
        string jsonPath = JsonSummaryWriter.Write(model, targetDir, jsonFileName);

        Console.WriteLine($"report:  {htmlPath}");
        Console.WriteLine($"summary: {jsonPath}");
        return 0;
    }

    /// <summary>
    /// Decides whether a user-supplied <c>--out &lt;file-or-dir&gt;</c> path names
    /// a directory or a specific output file, and resolves it to a
    /// (targetDir, htmlFileName, jsonFileName) triple. The rule, in order:
    /// <list type="number">
    /// <item>A path ending in a directory separator is always a directory.</item>
    /// <item>An existing directory is a directory.</item>
    /// <item>An existing file is that exact file (its parent is the target dir).</item>
    /// <item>A non-existent path whose extension is a recognized report
    /// extension (<c>.html</c>, <c>.htm</c>, <c>.json</c>) is a to-be-created
    /// file with that name.</item>
    /// <item>Anything else (no extension, or an unrecognized/dotted name such
    /// as <c>run.2026-07-01</c>) is a to-be-created directory.</item>
    /// </list>
    /// When resolved as a file, the file's own extension picks which artifact
    /// it renames (<c>.json</c> renames <c>summary.json</c>; anything else
    /// renames <c>report.html</c>); the other artifact keeps its default name
    /// in the same directory, since one <c>--out</c> file name cannot cover two
    /// distinct output artifacts.
    /// </summary>
    /// <param name="outPath">The raw <c>--out</c> value.</param>
    /// <returns>The resolved target directory and optional per-writer file names.</returns>
    private static (string TargetDir, string HtmlFileName, string JsonFileName) ResolveOutTarget(string outPath)
    {
        bool trailingSeparator = outPath.EndsWith(Path.DirectorySeparatorChar) ||
            outPath.EndsWith(Path.AltDirectorySeparatorChar);
        string fullPath = Path.GetFullPath(outPath);

        bool isDirectory = trailingSeparator
            || Directory.Exists(fullPath)
            || (!File.Exists(fullPath) && !IsRecognizedReportExtension(fullPath));

        if (isDirectory)
        {
            return (fullPath, null, null);
        }

        string targetDir = Path.GetDirectoryName(fullPath);
        string fileName = Path.GetFileName(fullPath);
        bool isJson = string.Equals(Path.GetExtension(fileName), ".json", StringComparison.OrdinalIgnoreCase);
        return isJson ? (targetDir, null, fileName) : (targetDir, fileName, null);
    }

    private static bool IsRecognizedReportExtension(string path)
    {
        string extension = Path.GetExtension(path);
        return string.Equals(extension, ".html", StringComparison.OrdinalIgnoreCase)
            || string.Equals(extension, ".htm", StringComparison.OrdinalIgnoreCase)
            || string.Equals(extension, ".json", StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveRunDir(string outputRoot, string runId)
    {
        string root = Path.GetFullPath(
            outputRoot ?? Path.Combine(Directory.GetCurrentDirectory(), "cs2gs-runs"));
        return Path.Combine(root, runId);
    }

    private static (string Corpus, List<string> AppIds, PipelineOptions Options, string BaselinePath, bool BaselineStrict)? ParseMigrateArgs(string[] args, out bool helpRequested)
    {
        helpRequested = false;
        string corpus = null;
        string baselinePath = null;
        bool baselineStrict = false;
        var appIds = new List<string>();
        var options = new PipelineOptions { OutputLayout = MigrationOutputLayout.Repository };

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            try
            {
                switch (arg)
                {
                    case "-h":
                    case "--help":
                        helpRequested = true;
                        PrintUsage();
                        return null;
                    case "--corpus":
                        corpus = NextValue(args, ref i, arg);
                        break;
                    case "--app":
                        appIds.Add(NextValue(args, ref i, arg));
                        break;
                    case "--gsc":
                        options.GscPath = NextValue(args, ref i, arg);
                        break;
                    case "--gsgen":
                        options.GsgenPath = NextValue(args, ref i, arg);
                        break;
                    case "--out":
                        options.OutputRoot = NextValue(args, ref i, arg);
                        break;
                    case "--artifacts":
                        options.ArtifactRoot = NextValue(args, ref i, arg);
                        break;
                    case "--diagnostic-run":
                        options.OutputLayout = MigrationOutputLayout.DiagnosticRun;
                        break;
                    case "--config":
                        options.Config = NextValue(args, ref i, arg);
                        break;
                    case "--baseline":
                        baselinePath = NextValue(args, ref i, arg);
                        break;
                    case "--baseline-strict":
                        baselineStrict = true;
                        break;
                    case "--via-sdk":
                        options.CompileViaSdk = true;
                        break;
                    case "--no-via-sdk":
                        options.CompileViaSdk = false;
                        break;
                    default:
                        Console.Error.WriteLine($"cs2gs: unknown option '{arg}'.");
                        PrintUsage();
                        return null;
                }
            }
            catch (MissingOptionValueException ex)
            {
                Console.Error.WriteLine("cs2gs: " + ex.Message);
                PrintUsage();
                return null;
            }
        }

        if (string.IsNullOrEmpty(corpus))
        {
            corpus = DefaultCorpus();
            if (corpus is null)
            {
                Console.Error.WriteLine("cs2gs: --corpus <dir> is required (no default corpus found).");
                return null;
            }
        }

        return (corpus, appIds, options, baselinePath, baselineStrict);
    }

    /// <summary>
    /// Reads the value following an option flag (e.g. <c>--gsc &lt;path&gt;</c>).
    /// </summary>
    /// <exception cref="MissingOptionValueException">
    /// The flag was the last token with no value following it. Callers catch
    /// this specific type and route it through the print-usage/return-1 path —
    /// a missing value is a usage error, not an internal error. Using a
    /// dedicated sentinel (rather than the base <see cref="ArgumentException"/>)
    /// keeps that catch from also swallowing an unrelated
    /// <see cref="ArgumentException"/> thrown by a case body (e.g. a future
    /// validating option setter), which must still escape to <see cref="Main"/>'s
    /// generic catch (exit code 2).
    /// </exception>
    private static string NextValue(string[] args, ref int index, string flag)
    {
        if (index + 1 >= args.Length)
        {
            throw new MissingOptionValueException($"option '{flag}' requires a value.");
        }

        return args[++index];
    }

    private static string DefaultCorpus()
    {
        var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static void PrintSummary(RunResult result, IReadOnlyList<IMigrationStage> stages)
    {
        var stageNames = stages.Select(s => TriageSerialization.StageName(s.Kind)).ToList();

        Console.WriteLine();
        Console.WriteLine($"cs2gs migrate — run {result.RunId}");
        Console.WriteLine($"gsc: {result.GscVersion}");
        Console.WriteLine();

        int idWidth = Math.Max(3, result.Apps.Select(a => a.AppId.Length).DefaultIfEmpty(3).Max());
        string header = "app".PadRight(idWidth) + "  " +
            string.Join("  ", stageNames.Select(n => n.PadRight(12)));
        Console.WriteLine(header);
        Console.WriteLine(new string('-', header.Length));

        foreach (AppResult app in result.Apps)
        {
            var cells = new List<string>();
            foreach (string stageName in stageNames)
            {
                StageResult stage = app.Stages.FirstOrDefault(s => s.Stage == stageName);
                cells.Add(FormatCell(stage).PadRight(12));
            }

            Console.WriteLine(app.AppId.PadRight(idWidth) + "  " + string.Join("  ", cells));
            if (!app.Succeeded)
            {
                foreach (string artifact in app.Artifacts)
                {
                    Console.WriteLine($"    -> {app.FailureCategory}: {artifact}");
                }
            }
        }

        Console.WriteLine();

        // Same precedence as the report (issue #1831): a run-level failure
        // always wins; otherwise call out unverified apps rather than
        // rendering them as a plain pass.
        int passed = result.Apps.Count(a => a.Succeeded && !a.Unverified);
        int unverified = result.Apps.Count(a => a.Unverified);
        string verdict = !result.Succeeded
            ? "FAILED"
            : unverified > 0 ? $"PASSED ({unverified} unverified)" : "PASSED";
        Console.WriteLine($"{passed}/{result.Apps.Count} apps green; run {verdict}.");
    }

    private static string FormatCell(StageResult stage)
    {
        if (stage is null)
        {
            return "-";
        }

        return stage.Status switch
        {
            "passed" => "PASS",
            "failed" => $"FAIL({stage.ArtifactCount})",
            "skipped" => "skip",
            _ => stage.Status,
        };
    }

    private static void PrintUsage()
    {
        Console.WriteLine("cs2gs - C# to G# migration tool (ADR-0115)");
        Console.WriteLine();
        Console.WriteLine("Usage:");
        Console.WriteLine("  cs2gs migrate [options]");
        Console.WriteLine("  cs2gs report --run <runDir> [--out <file-or-dir>]");
        Console.WriteLine("  cs2gs coverage [--write] [--repo-root <dir>]");
        Console.WriteLine("  cs2gs triage list --run <runDir> [--gaps <file>]");
        Console.WriteLine("  cs2gs triage file-issues --run <runDir> [--gaps <file>] [--file] [--limit N] [--milestone M]");
        Console.WriteLine("  cs2gs triage sync [--gaps <file>] [--write] [--no-test-reason <why>]");
        Console.WriteLine();
        Console.WriteLine("migrate options:");
        Console.WriteLine("  --corpus <dir>    Source repository root (default: tools/cs2gs/corpus).");
        Console.WriteLine("  --out <dir>       Empty destination repository (required by default).");
        Console.WriteLine("  --artifacts <dir> Validation runs root (default: <out>.cs2gs-runs).");
        Console.WriteLine("  --diagnostic-run  Preserve the historical timestamped corpus/CI layout.");
        Console.WriteLine("  --app <id>        Diagnostic-run only; migrate one app (repeatable).");
        Console.WriteLine("  --gsc <path>      Override gsc.dll (default: out/bin/<Config>/Compiler/gsc.dll).");
        Console.WriteLine("  --gsgen <path>    Override gsgen.dll (default: out/bin/<Config>/Gsgen.Cli/gsgen.dll); issue #2215.");
        Console.WriteLine("                    With --diagnostic-run, --out is the runs root.");
        Console.WriteLine("  --config <name>   Build config used to find gsc (default: Release).");
        Console.WriteLine("  --baseline <file> Gate on the gap ledger (tools/cs2gs/triage/gaps.json): fail only on");
        Console.WriteLine("                    NEW or REGRESSED fingerprints; known-open gaps are tolerated.");
        Console.WriteLine("  --baseline-strict Also fail on STALE ledger entries (nightly mode).");
        Console.WriteLine("  --via-sdk         Build emitted G# via 'dotnet build' + Gsharp.NET.Sdk (default).");
        Console.WriteLine("  --no-via-sdk      Use the legacy direct-gsc compile path.");
        Console.WriteLine();
        Console.WriteLine("report options:");
        Console.WriteLine("  --run <dir>       Existing run directory containing run.json (required).");
        Console.WriteLine("  --out <file-or-dir>");
        Console.WriteLine("                    Output location for report.html + summary.json (default: the run dir).");
        Console.WriteLine("                    A trailing slash or an existing directory is always a directory.");
        Console.WriteLine("                    A path ending in .html/.htm/.json (or an existing file) names that one");
        Console.WriteLine("                    output file directly; the other artifact keeps its default name");
        Console.WriteLine("                    alongside it. Any other path is created as a directory.");
        Console.WriteLine();
        Console.WriteLine("coverage options:");
        Console.WriteLine("  --write           Append skeleton rows for new Roslyn node kinds, canonicalize the");
        Console.WriteLine("                    construct inventory, and regenerate the docs matrix + surface golden.");
        Console.WriteLine("  --repo-root <dir> Repository root (default: walk up from the current directory).");
        Console.WriteLine();
        Console.WriteLine("A migrate run also writes report.html + summary.json into the run dir automatically (ADR-0115 §F).");
        Console.WriteLine();
        Console.WriteLine("Exit code is non-zero if any app fails a stage (so CI can gate).");
    }

    /// <summary>
    /// Sentinel exception thrown by <see cref="NextValue"/> when an option's
    /// value is missing, so verb loops can catch exactly this case as a usage
    /// error without also catching unrelated <see cref="ArgumentException"/>s.
    /// </summary>
    private sealed class MissingOptionValueException : ArgumentException
    {
        public MissingOptionValueException(string message)
            : base(message)
        {
        }
    }
}

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
    /// <returns>The process exit code (non-zero if any app failed).</returns>
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

        Console.Error.WriteLine($"cs2gs: unknown command '{verb}'.");
        PrintUsage();
        return 1;
    }

    private static async Task<int> RunMigrateAsync(string[] args)
    {
        (string Corpus, List<string> AppIds, PipelineOptions Options)? parsed = ParseMigrateArgs(args);
        if (parsed is null)
        {
            return 1;
        }

        (string corpus, List<string> appIds, PipelineOptions options) = parsed.Value;

        IReadOnlyList<CorpusApp> apps;
        if (appIds.Count > 0)
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

        string runDir = ResolveRunDir(options.OutputRoot, result.RunId);
        GenerateReport(runDir);

        return result.Succeeded ? 0 : 1;
    }

    private static int RunReport(string[] args)
    {
        string runDir = null;
        string outPath = null;

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            switch (arg)
            {
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
        if (!string.IsNullOrEmpty(outPath))
        {
            targetDir = Directory.Exists(outPath) || HasNoExtension(outPath)
                ? outPath
                : Path.GetDirectoryName(Path.GetFullPath(outPath));
            Directory.CreateDirectory(targetDir);
        }

        ReportModel model = ReportModel.FromRunDirectory(runDir);
        string htmlPath = HtmlReportWriter.Write(model, targetDir);
        string jsonPath = JsonSummaryWriter.Write(model, targetDir);

        Console.WriteLine($"report:  {htmlPath}");
        Console.WriteLine($"summary: {jsonPath}");
        return 0;
    }

    private static bool HasNoExtension(string path)
    {
        return string.IsNullOrEmpty(Path.GetExtension(path));
    }

    private static string ResolveRunDir(string outputRoot, string runId)
    {
        string root = Path.GetFullPath(
            outputRoot ?? Path.Combine(Directory.GetCurrentDirectory(), "cs2gs-runs"));
        return Path.Combine(root, runId);
    }

    private static void GenerateReport(string runDir)
    {
        try
        {
            ReportModel model = ReportModel.FromRunDirectory(runDir);
            string htmlPath = HtmlReportWriter.Write(model, runDir);
            string jsonPath = JsonSummaryWriter.Write(model, runDir);
            Console.WriteLine();
            Console.WriteLine($"report:  {htmlPath}");
            Console.WriteLine($"summary: {jsonPath}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("cs2gs: failed to generate report: " + ex.Message);
        }
    }

    private static (string Corpus, List<string> AppIds, PipelineOptions Options)? ParseMigrateArgs(string[] args)
    {
        string corpus = null;
        var appIds = new List<string>();
        var options = new PipelineOptions();

        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            switch (arg)
            {
                case "--corpus":
                    corpus = NextValue(args, ref i, arg);
                    break;
                case "--app":
                    appIds.Add(NextValue(args, ref i, arg));
                    break;
                case "--gsc":
                    options.GscPath = NextValue(args, ref i, arg);
                    break;
                case "--out":
                    options.OutputRoot = NextValue(args, ref i, arg);
                    break;
                case "--config":
                    options.Config = NextValue(args, ref i, arg);
                    break;
                default:
                    Console.Error.WriteLine($"cs2gs: unknown option '{arg}'.");
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

        return (corpus, appIds, options);
    }

    private static string NextValue(string[] args, ref int index, string flag)
    {
        if (index + 1 >= args.Length)
        {
            throw new ArgumentException($"option '{flag}' requires a value.");
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
        int passed = result.Apps.Count(a => a.Succeeded);
        string verdict = result.Succeeded ? "PASSED" : "FAILED";
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
        Console.WriteLine();
        Console.WriteLine("migrate options:");
        Console.WriteLine("  --corpus <dir>    Corpus root (default: tools/cs2gs/corpus).");
        Console.WriteLine("  --app <id>        Migrate only this app (repeatable, e.g. corpus/L1-Console).");
        Console.WriteLine("  --gsc <path>      Override gsc.dll (default: out/bin/<Config>/Compiler/gsc.dll).");
        Console.WriteLine("  --out <dir>       Runs root for artifacts (default: ./cs2gs-runs).");
        Console.WriteLine("  --config <name>   Build config used to find gsc (default: Release).");
        Console.WriteLine();
        Console.WriteLine("report options:");
        Console.WriteLine("  --run <dir>       Existing run directory containing run.json (required).");
        Console.WriteLine("  --out <dir>       Output directory for report.html + summary.json (default: the run dir).");
        Console.WriteLine();
        Console.WriteLine("A migrate run also writes report.html + summary.json into the run dir automatically (ADR-0115 §F).");
        Console.WriteLine();
        Console.WriteLine("Exit code is non-zero if any app fails a stage (so CI can gate).");
    }
}

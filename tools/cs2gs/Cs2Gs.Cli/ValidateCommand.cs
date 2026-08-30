// <copyright file="ValidateCommand.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;

namespace Cs2Gs.Cli;

/// <summary>
/// The <c>validate</c> verb (issue #3668): run the post-translate stages —
/// compile → ilverify → test-parity — for a SUBSET of apps against a tree that
/// a previous whole-repository <c>migrate --translate-only</c> pass already
/// migrated, and write a partial <c>run.json</c>.
/// <para>
/// This is the shardable half of the self-migration gate. Translation itself
/// deliberately stays one whole-repository pass: linked sources compiled into
/// several projects are cross-checked for identical translations, and that
/// guard only exists when every project translates in the same run. Stages 2–4
/// read the migrated tree and are independent per app, so they parallelize.
/// </para>
/// <para>
/// Sharding NEVER narrows the discovered app set: <c>--exclude</c> must match
/// the migrate pass exactly, because excluding a project another app
/// project-references breaks reference resolution and produces large phantom
/// cascades. <c>--app</c>/<c>--shard</c> select which apps are EXECUTED, not
/// which exist.
/// </para>
/// </summary>
internal static class ValidateCommand
{
    /// <summary>
    /// Parses the <c>validate</c> arguments and runs the shard.
    /// </summary>
    /// <param name="args">The arguments following the verb.</param>
    /// <returns>0 when every selected app is green, 1 on failures, 2 on usage errors.</returns>
    internal static async Task<int> RunAsync(string[] args)
    {
        string corpus = null;
        string migrated = null;
        string manifests = null;
        int shardIndex = -1;
        int shardCount = 0;
        var appIds = new List<string>();
        var options = new PipelineOptions { OutputLayout = MigrationOutputLayout.Repository };

        for (var i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            switch (arg)
            {
                case "-h":
                case "--help":
                    PrintUsage();
                    return 0;
                case "--corpus":
                    corpus = Next(args, ref i, arg);
                    break;
                case "--migrated":
                    migrated = Next(args, ref i, arg);
                    break;
                case "--artifacts":
                    options.ArtifactRoot = Next(args, ref i, arg);
                    break;
                case "--manifests":
                    manifests = Next(args, ref i, arg);
                    break;
                case "--app":
                    appIds.Add(Next(args, ref i, arg).Replace('\\', '/'));
                    break;
                case "--shard":
                    if (!TryParseShard(Next(args, ref i, arg), out shardIndex, out shardCount))
                    {
                        Console.Error.WriteLine("cs2gs: --shard expects <index>/<count> with 1 <= index <= count.");
                        return 1;
                    }

                    break;
                case "--exclude":
                    options.ExcludeAppIdPrefixes.Add(Next(args, ref i, arg).Replace('\\', '/').TrimEnd('/'));
                    break;
                case "--config":
                    options.Config = Next(args, ref i, arg);
                    break;
                case "--gsc":
                    options.GscPath = Next(args, ref i, arg);
                    break;
                case "--gsgen":
                    options.GsgenPath = Next(args, ref i, arg);
                    break;
                default:
                    Console.Error.WriteLine($"cs2gs: unknown option '{arg}'.");
                    PrintUsage();
                    return 1;
            }
        }

        if (string.IsNullOrEmpty(corpus))
        {
            Console.Error.WriteLine("cs2gs: validate requires --corpus <repo-root>.");
            return 1;
        }

        if (string.IsNullOrEmpty(migrated))
        {
            Console.Error.WriteLine("cs2gs: validate requires --migrated <migrated-tree>.");
            return 1;
        }

        options.SourceRoot = Path.GetFullPath(corpus);
        options.OutputRoot = Path.GetFullPath(migrated);
        options.ArtifactRoot = string.IsNullOrEmpty(options.ArtifactRoot)
            ? options.OutputRoot + ".cs2gs-runs"
            : Path.GetFullPath(options.ArtifactRoot);

        manifests = string.IsNullOrEmpty(manifests)
            ? FindLatestRunDir(options.ArtifactRoot)
            : Path.GetFullPath(manifests);
        if (string.IsNullOrEmpty(manifests) || !Directory.Exists(manifests))
        {
            Console.Error.WriteLine(
                "cs2gs: validate requires --manifests <migrate-run-dir> (no run directory could be inferred).");
            return 1;
        }

        // The FULL discovered set, with exactly the migrate pass's exclusions:
        // the mirrored-project reference map has to stay repository-wide.
        IReadOnlyList<CorpusApp> allApps = ApplyExclusions(
            RepositoryDiscovery.Discover(options.SourceRoot), options);
        if (allApps.Count == 0)
        {
            Console.Error.WriteLine($"cs2gs: no projects discovered under {options.SourceRoot}.");
            return 1;
        }

        IReadOnlyList<CorpusApp> selected = SelectApps(allApps, appIds, shardIndex, shardCount, out string error);
        if (error is not null)
        {
            Console.Error.WriteLine("cs2gs: " + error);
            return 1;
        }

        Console.WriteLine(
            $"cs2gs validate: {selected.Count} of {allApps.Count} app(s) selected; " +
            $"migrated tree {options.OutputRoot}; manifests {manifests}.");

        var pipeline = new MigrationPipeline(options, ValidationStages());
        RunResult result = await pipeline
            .ValidateAsync(allApps, selected, manifests)
            .ConfigureAwait(false);

        Program.PrintSummary(result, pipeline.Stages);

        string runDir = Path.Combine(options.ArtifactRoot, result.RunId);
        Console.WriteLine($"partial run: {Path.Combine(runDir, "run.json")}");
        Program.GenerateReport(runDir);

        return result.Succeeded ? 0 : 1;
    }

    /// <summary>
    /// Gets the stages a validation shard runs: everything after translate.
    /// Translate is excluded by construction, not by a runtime skip, so a shard
    /// can never silently re-translate a subset of the repository.
    /// </summary>
    /// <returns>The ordered post-translate stages.</returns>
    internal static IReadOnlyList<IMigrationStage> ValidationStages() => new IMigrationStage[]
    {
        new CompileStage(),
        new IlVerifyStage(),
        new TestParityStage(),
    };

    /// <summary>
    /// Selects the apps a shard executes: an explicit <c>--app</c> list, or a
    /// deterministic <c>--shard i/N</c> stripe over the discovered order.
    /// </summary>
    /// <param name="allApps">The full discovered app list.</param>
    /// <param name="appIds">Explicit app ids (may be empty).</param>
    /// <param name="shardIndex">The 1-based shard index, or -1.</param>
    /// <param name="shardCount">The shard count, or 0.</param>
    /// <param name="error">Set to a message when the selection is invalid.</param>
    /// <returns>The selected apps, in discovered order.</returns>
    internal static IReadOnlyList<CorpusApp> SelectApps(
        IReadOnlyList<CorpusApp> allApps,
        IReadOnlyList<string> appIds,
        int shardIndex,
        int shardCount,
        out string error)
    {
        error = null;
        if (appIds.Count > 0 && shardCount > 0)
        {
            error = "--app and --shard are mutually exclusive.";
            return Array.Empty<CorpusApp>();
        }

        if (appIds.Count > 0)
        {
            var selected = new List<CorpusApp>();
            foreach (string id in appIds)
            {
                CorpusApp app = allApps.FirstOrDefault(a =>
                    string.Equals(a.Id, id, StringComparison.OrdinalIgnoreCase));
                if (app is null)
                {
                    error = $"app '{id}' is not in the discovered (post-exclude) app set.";
                    return Array.Empty<CorpusApp>();
                }

                selected.Add(app);
            }

            return selected;
        }

        if (shardCount > 0)
        {
            return allApps.Where((_, index) => (index % shardCount) == (shardIndex - 1)).ToList();
        }

        return allApps;
    }

    /// <summary>Parses an <c>i/N</c> shard specification.</summary>
    /// <param name="value">The raw option value.</param>
    /// <param name="index">The parsed 1-based index.</param>
    /// <param name="count">The parsed shard count.</param>
    /// <returns><see langword="true"/> when the specification is well formed.</returns>
    internal static bool TryParseShard(string value, out int index, out int count)
    {
        index = -1;
        count = 0;
        string[] parts = (value ?? string.Empty).Split('/');
        return parts.Length == 2
            && int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out index)
            && int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out count)
            && count > 0
            && index >= 1
            && index <= count;
    }

    private static IReadOnlyList<CorpusApp> ApplyExclusions(
        IReadOnlyList<CorpusApp> apps,
        PipelineOptions options)
    {
        if (options.ExcludeAppIdPrefixes.Count == 0)
        {
            return apps;
        }

        var kept = new List<CorpusApp>(apps.Count);
        foreach (CorpusApp app in apps)
        {
            if (options.ExcludeAppIdPrefixes.Any(prefix =>
                app.Id.StartsWith(prefix, StringComparison.Ordinal)))
            {
                options.ExcludedProjectPaths.Add(app.ProjectPath);
            }
            else
            {
                kept.Add(app);
            }
        }

        return kept;
    }

    private static string FindLatestRunDir(string artifactRoot)
    {
        if (!Directory.Exists(artifactRoot))
        {
            return null;
        }

        return Directory.EnumerateDirectories(artifactRoot)
            .Where(dir => File.Exists(Path.Combine(dir, "run.json")))
            .OrderBy(dir => new DirectoryInfo(dir).Name, StringComparer.Ordinal)
            .LastOrDefault();
    }

    private static string Next(string[] args, ref int index, string flag)
    {
        if (index + 1 >= args.Length)
        {
            throw new ArgumentException($"option '{flag}' requires a value.");
        }

        return args[++index];
    }

    private static void PrintUsage()
    {
        Console.WriteLine("cs2gs validate - validate an already-migrated tree for a subset of apps (issue #3668)");
        Console.WriteLine();
        Console.WriteLine("Usage:");
        Console.WriteLine("  cs2gs validate --corpus <repo-root> --migrated <dir> [options]");
        Console.WriteLine();
        Console.WriteLine("options:");
        Console.WriteLine("  --corpus <dir>     The ORIGINAL repository root the tree was migrated from (required).");
        Console.WriteLine("  --migrated <dir>   The already-migrated tree to validate (required).");
        Console.WriteLine("  --artifacts <dir>  Runs root for this shard's logs/triage (default: <migrated>.cs2gs-runs).");
        Console.WriteLine("  --manifests <dir>  The migrate run directory holding per-app validation-context.json");
        Console.WriteLine("                     (default: the newest run directory under --artifacts).");
        Console.WriteLine("  --app <id>         Validate this app (repeatable).");
        Console.WriteLine("  --shard <i>/<N>    Validate every Nth app starting at i (1-based); excludes --app.");
        Console.WriteLine("  --exclude <path>   MUST match the migrate pass exactly — it defines the discovered set,");
        Console.WriteLine("                     not the executed subset. Narrowing it breaks reference resolution.");
        Console.WriteLine("  --config <name>    Build config used to find gsc and the SDK package (default: Release).");
        Console.WriteLine("  --gsc <path>       Override gsc.dll.");
        Console.WriteLine("  --gsgen <path>     Override gsgen.dll.");
    }
}

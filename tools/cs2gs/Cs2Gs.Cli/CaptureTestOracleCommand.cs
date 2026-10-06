// <copyright file="CaptureTestOracleCommand.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Cs2Gs.Pipeline;

namespace Cs2Gs.Cli;

/// <summary>
/// The <c>capture-test-oracle</c> verb (issue #4633): lists the test cases of
/// every C# test project the self-migration will mirror and writes one
/// <see cref="CSharpTestOracle"/> per project, for <c>cs2gs validate
/// --csharp-test-oracle</c> to compare the migrated runs against name for name.
/// <para>
/// It discovers apps exactly as <c>validate</c> does (same <c>--exclude</c> /
/// <c>--passthrough</c> semantics) and selects them with the test-parity
/// stage's own <see cref="TestParityStage.IsMirroredTestProject"/> predicate, so the
/// two cannot disagree silently: a project the stage treats as a test project
/// but this verb skipped fails its parity with <c>TEST-ORACLE-MISSING</c>.
/// </para>
/// </summary>
internal static class CaptureTestOracleCommand
{
    private static readonly TimeSpan BuildTimeout = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan ListTimeout = TimeSpan.FromMinutes(15);

    /// <summary>
    /// Parses the arguments and captures the oracles.
    /// </summary>
    /// <param name="args">The arguments following the verb.</param>
    /// <returns>0 when every oracle was captured, 1 when any failed or on usage errors.</returns>
    internal static int Run(string[] args)
    {
        try
        {
            return RunCore(args);
        }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine("cs2gs: " + ex.Message);
            PrintUsage();
            return 1;
        }
    }

    private static int RunCore(string[] args)
    {
        string corpus = null;
        string outDir = null;
        string config = "Release";
        string manifests = null;
        bool build = true;
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
                case "--out":
                    outDir = Next(args, ref i, arg);
                    break;
                case "--config":
                    config = Next(args, ref i, arg);
                    break;
                case "--manifests":
                    manifests = Next(args, ref i, arg);
                    break;
                case "--no-build":
                    build = false;
                    break;
                case "--app":
                    appIds.Add(Next(args, ref i, arg).Replace('\\', '/'));
                    break;
                case "--exclude":
                    options.ExcludeAppIdPrefixes.Add(Next(args, ref i, arg).Replace('\\', '/').TrimEnd('/'));
                    break;
                case "--passthrough":
                    options.PassthroughAppIdPrefixes.Add(Next(args, ref i, arg).Replace('\\', '/').TrimEnd('/'));
                    break;
                default:
                    Console.Error.WriteLine($"cs2gs: unknown option '{arg}'.");
                    PrintUsage();
                    return 1;
            }
        }

        if (string.IsNullOrEmpty(corpus) || string.IsNullOrEmpty(outDir))
        {
            Console.Error.WriteLine("cs2gs: capture-test-oracle requires --corpus <repo-root> and --out <dir>.");
            return 1;
        }

        string root = CanonicalRootPath.Resolve(corpus);
        outDir = Path.GetFullPath(outDir);
        Directory.CreateDirectory(outDir);

        IReadOnlyList<CorpusApp> testApps = ValidateCommand
            .ApplyExclusions(RepositoryDiscovery.Discover(root), options)
            .Where(app => appIds.Count == 0 || appIds.Contains(app.Id, StringComparer.Ordinal))
            .Where(app => TestParityStage.IsMirroredTestProject(EvaluatedIsTestProject(manifests, app.Id), app.ProjectPath))
            .OrderBy(app => app.Id, StringComparer.Ordinal)
            .ToList();
        if (testApps.Count == 0)
        {
            Console.Error.WriteLine("cs2gs: capture-test-oracle found no test projects under " + root + ".");
            return 1;
        }

        var failures = new List<string>();
        foreach (CorpusApp app in testApps)
        {
            string error = Capture(app, root, outDir, config, build);
            if (error is null)
            {
                continue;
            }

            failures.Add(app.Id + ": " + error);
            Console.Error.WriteLine("cs2gs capture-test-oracle: FAILED " + app.Id + ": " + error);
        }

        Console.WriteLine(
            $"cs2gs capture-test-oracle: {testApps.Count - failures.Count} of {testApps.Count} test project(s) " +
            $"captured into {outDir}.");
        return failures.Count == 0 ? 0 : 1;
    }

    private static string Capture(CorpusApp app, string root, string outDir, string config, bool build)
    {
        // A failed capture must leave NO oracle for the app, never an earlier
        // run's: validation then fails closed with TEST-ORACLE-MISSING.
        string previous = Path.Combine(outDir, CSharpTestOracle.FileNameFor(app.Id));
        try
        {
            if (File.Exists(previous))
            {
                File.Delete(previous);
            }
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            return "could not remove the previous oracle " + previous + ": " + ex.Message;
        }

        var environment = new Dictionary<string, string>
        {
            // The listing header is parsed literally; pin the CLI language.
            ["DOTNET_CLI_UI_LANGUAGE"] = "en",
            ["MSBUILDDISABLENODEREUSE"] = "1",
        };

        if (build)
        {
            ProcessRunResult built = ProcessRunner.Run(
                "dotnet",
                new[] { "build", app.ProjectPath, "-c", config, "-graph", "-nodeReuse:false" },
                root,
                BuildTimeout,
                environment);
            if (built.ExitCode != 0 || built.TimedOut)
            {
                return "the C# build failed (exit " + built.ExitCode.ToString(CultureInfo.InvariantCulture) +
                    (built.TimedOut ? ", timed out" : string.Empty) + "):\n" + Tail(built.Output);
            }
        }

        ProcessRunResult listed = ProcessRunner.Run(
            "dotnet",
            new[]
            {
                "test", app.ProjectPath, "-c", config, "--no-build", "--list-tests",
                "--", CSharpTestOracle.RunSettingsArgument,
            },
            root,
            ListTimeout,
            environment);
        if (listed.ExitCode != 0 || listed.TimedOut)
        {
            return "`dotnet test --list-tests` failed (exit " + listed.ExitCode.ToString(CultureInfo.InvariantCulture) +
                (listed.TimedOut ? ", timed out" : string.Empty) + "):\n" + Tail(listed.Output);
        }

        IReadOnlyList<string> names;
        try
        {
            names = CSharpTestOracle.ParseListTestsOutput(listed.Stdout);
        }
        catch (InvalidOperationException ex)
        {
            return ex.Message;
        }

        string path = CSharpTestOracle.Create(app.Id, names).Write(outDir);
        Console.WriteLine(
            $"cs2gs capture-test-oracle: {app.Id}: {names.Count} case(s) -> {Path.GetFileName(path)}");
        return null;
    }

    /// <summary>
    /// The translate pass's evaluated MSBuild <c>IsTestProject</c> for an app,
    /// read from its validation manifest; <see langword="false"/> when no
    /// manifest directory was given or the app has none.
    /// </summary>
    private static bool EvaluatedIsTestProject(string manifests, string appId)
    {
        if (string.IsNullOrEmpty(manifests))
        {
            return false;
        }

        ValidationManifest manifest = ValidationManifest.Read(Path.Combine(
            manifests, MigrationPipeline.ArtifactDirectoryName(appId, MigrationOutputLayout.Repository)));
        return manifest is not null && manifest.IsTestProject;
    }

    private static string Tail(string output)
    {
        string text = (output ?? string.Empty).Trim();
        return text.Length <= 3000 ? text : text.Substring(text.Length - 3000);
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
        Console.WriteLine("cs2gs capture-test-oracle - list the C# test cases per-test-name parity compares against (issue #4633)");
        Console.WriteLine();
        Console.WriteLine("Usage:");
        Console.WriteLine("  cs2gs capture-test-oracle --corpus <repo-root> --out <dir> [options]");
        Console.WriteLine();
        Console.WriteLine("options:");
        Console.WriteLine("  --corpus <dir>     The C# repository root (required).");
        Console.WriteLine("  --out <dir>        Where to write one oracle per test project (required); each file is named");
        Console.WriteLine("                     <sanitized app id>-<8-hex hash>" + CSharpTestOracle.FileSuffix + ".");
        Console.WriteLine("  --config <name>    Build configuration (default: Release).");
        Console.WriteLine("  --manifests <dir>  The migrate run directory; its validation manifests add the evaluated");
        Console.WriteLine("                     MSBuild IsTestProject to the classification (recommended).");
        Console.WriteLine("  --no-build         List already-built test assemblies.");
        Console.WriteLine("  --app <id>         Capture only this app (repeatable).");
        Console.WriteLine("  --exclude <path>   Same meaning as for migrate/validate.");
        Console.WriteLine("  --passthrough <path>  Same meaning as for migrate/validate.");
    }
}

// <copyright file="CaptureTestOracleCommand.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Cli

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq

/// The `capture-test-oracle` verb (issue #4633): lists the test cases of
/// every C# test project the self-migration will mirror and writes one
/// (cref:CSharpTestOracle) per project, for `cs2gs validate
/// --csharp-test-oracle` to compare the migrated runs against name for name.
///
/// It discovers apps exactly as `validate` does (same `--exclude` /
/// `--passthrough` semantics) and selects them with the test-parity
/// stage's own (cref:TestParityStage.IsMirroredTestProject) predicate, so the
/// two cannot disagree silently: a project the stage treats as a test project
/// but this verb skipped fails its parity with `TEST-ORACLE-MISSING`.
internal shared class CaptureTestOracleCommand {
    private let BuildTimeout TimeSpan = TimeSpan.FromMinutes(30)
    private let ListTimeout TimeSpan = TimeSpan.FromMinutes(15)

    /// Parses the arguments and captures the oracles.
    /// @param args The arguments following the verb.
    /// @returns 0 when every oracle was captured, 1 when any failed or on usage errors.
    internal func Run(args[]string) int32 {
        try {
            return RunCore(args)
        } catch (ex ArgumentException) {
            Console.Error.WriteLine("cs2gs: " + ex.Message)
            PrintUsage()
            return 1
        }
    }

    private func RunCore(args[]string) int32 {
        var corpus string? = nil
        var outDir string? = nil
        var config = "Release"
        var manifests string? = nil
        var build = true
        let appIds = List[string]()
        let options = PipelineOptions{OutputLayout: MigrationOutputLayout.Repository}
        for var i = 0; i < args.Length; i++ {
            let arg = args[i]
            switch arg {
                case "-h", "--help" {
                    PrintUsage()
                    return 0
                }
                case "--corpus" {
                    corpus = Next(args, &i, arg)
                }
                case "--out" {
                    outDir = Next(args, &i, arg)
                }
                case "--config" {
                    config = Next(args, &i, arg)
                }
                case "--manifests" {
                    manifests = Next(args, &i, arg)
                }
                case "--no-build" {
                    build = false
                }
                case "--app" {
                    appIds.Add(Next(args, &i, arg).Replace('\\', '/'))
                }
                case "--exclude" {
                    options.ExcludeAppIdPrefixes.Add(Next(args, &i, arg).Replace('\\', '/').TrimEnd('/'))
                }
                case "--passthrough" {
                    options.PassthroughAppIdPrefixes.Add(Next(args, &i, arg).Replace('\\', '/').TrimEnd('/'))
                }
                default {
                    Console.Error.WriteLine("cs2gs: unknown option '$arg'.")
                    PrintUsage()
                    return 1
                }
            }
        }
        if string.IsNullOrEmpty(corpus) || string.IsNullOrEmpty(outDir) {
            Console.Error.WriteLine("cs2gs: capture-test-oracle requires --corpus <repo-root> and --out <dir>.")
            return 1
        }
        let root string? = CanonicalRootPath.Resolve(corpus)
        outDir = Path.GetFullPath(outDir!!)
        Directory.CreateDirectory(outDir)
        let apps = ValidateCommand.ApplyExclusions(RepositoryDiscovery.Discover(root), options)
        for appId in appIds {
            if !apps.Any((app CorpusApp) -> string.Equals(app.Id, appId, StringComparison.Ordinal)) {
                Console.Error.WriteLine("cs2gs: capture-test-oracle found no app '" + appId + "'.")
                return 1
            }
        }
        let testApps IReadOnlyList[CorpusApp] = apps
            .Where((app CorpusApp) -> appIds.Count == 0 || appIds.Contains(app.Id, StringComparer.Ordinal))
            .Where(
            (app CorpusApp) -> TestParityStage.IsMirroredTestProject(
                EvaluatedIsTestProject(manifests, app.Id),
                app.ProjectPath
            )
        )
            .OrderBy((app CorpusApp) -> app.Id, StringComparer.Ordinal)
            .ToList()
        if testApps.Count == 0 && appIds.Count == 0 {
            Console.Error.WriteLine("cs2gs: capture-test-oracle found no test projects under " + root + ".")
            return 1
        }
        let failures = List[string]()
        for app in testApps {
            let error string? = Capture(app, root, outDir, config, build)
            if error == nil {
                continue
            }
            failures.Add(app.Id + ": " + error)
            Console.Error.WriteLine("cs2gs capture-test-oracle: FAILED " + app.Id + ": " + error)
        }
        Console.WriteLine(
            "cs2gs capture-test-oracle: ${testApps.Count - failures.Count} of ${testApps.Count} test project(s) " +
                "captured into $outDir."
        )
        return if failures.Count == 0 {
            0
        } else {
            1
        }
    }

    private func Capture(app CorpusApp, root string?, outDir string?, config string, build bool) string? {
        // A failed capture must leave NO oracle for the app, never an earlier
        // run's: validation then fails closed with TEST-ORACLE-MISSING.
        let previous = Path.Combine(outDir!!, CSharpTestOracle.FileNameFor(app.Id))
        try {
            if File.Exists(previous) {
                File.Delete(previous)
            }
        } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException {
            return "could not remove the previous oracle " + previous + ": " + ex.Message
        }
        let environment = Dictionary[string, string]{
            ["DOTNET_CLI_UI_LANGUAGE"] = "en",
            ["MSBUILDDISABLENODEREUSE"] = "1"
        }
        if build {
            let built = ProcessRunner.Run(
                "dotnet",
                []string{"build", app.ProjectPath, "-c", config, "-graph", "-nodeReuse:false"},
                root,
                BuildTimeout,
                environment
            )
            if built.ExitCode != 0 || built.TimedOut {
                return "the C# build failed (exit " + built.ExitCode.ToString(CultureInfo.InvariantCulture) +
                    (
                    if built.TimedOut {
                        ", timed out"
                    } else {
                        string.Empty
                    }
                ) +
                    "):\n" +
                    Tail(built.Output)
            }
        }
        let listed = ProcessRunner.Run(
            "dotnet",
            []string{
                "test",
                app.ProjectPath,
                "-c",
                config,
                "--no-build",
                "--list-tests",
                "--",
                CSharpTestOracle.RunSettingsArgument
            },
            root,
            ListTimeout,
            environment
        )
        if listed.ExitCode != 0 || listed.TimedOut {
            return "`dotnet test --list-tests` failed (exit " + listed.ExitCode.ToString(CultureInfo.InvariantCulture) +
                (
                if listed.TimedOut {
                    ", timed out"
                } else {
                    string.Empty
                }
            ) +
                "):\n" +
                Tail(listed.Output)
        }
        var names IReadOnlyList[string]
        try {
            names = CSharpTestOracle.ParseListTestsOutput(listed.Stdout)
        } catch (ex InvalidOperationException) {
            return ex.Message
        }
        let path = CSharpTestOracle.Create(app.Id, names).Write(outDir)
        Console.WriteLine("cs2gs capture-test-oracle: ${app.Id}: ${names.Count} case(s) -> ${Path.GetFileName(path)}")
        return nil
    }

    /// The translate pass's evaluated MSBuild `IsTestProject` for an app,
    /// read from its validation manifest; `false` when no
    /// manifest directory was given or the app has none.
    private func EvaluatedIsTestProject(manifests string?, appId string) bool {
        if string.IsNullOrEmpty(manifests) {
            return false
        }
        let manifest ValidationManifest? = ValidationManifest.Read(
            Path.Combine(manifests, MigrationPipeline.ArtifactDirectoryName(appId, MigrationOutputLayout.Repository))
        )
        return manifest != nil && manifest.IsTestProject
    }

    private func Tail(output string) string {
        let text = (output ?? string.Empty).Trim()
        return if text.Length <= 3000 {
            text
        } else {
            text.Substring(text.Length - 3000)
        }
    }

    private func Next(args[]string, ref index int32, flag string) string {
        if index + 1 >= args.Length {
            throw ArgumentException("option '$flag' requires a value.")
        }
        return args[(index += 1)]
    }

    private func PrintUsage() {
        Console.WriteLine(
            "cs2gs capture-test-oracle - list the C# test cases per-test-name parity compares against (issue #4633)"
        )
        Console.WriteLine()
        Console.WriteLine("Usage:")
        Console.WriteLine("  cs2gs capture-test-oracle --corpus <repo-root> --out <dir> [options]")
        Console.WriteLine()
        Console.WriteLine("options:")
        Console.WriteLine("  --corpus <dir>     The C# repository root (required).")
        Console.WriteLine(
            "  --out <dir>        Where to write one oracle per test project (required); each file is named"
        )
        Console.WriteLine("                     <sanitized app id>-<8-hex hash>" + CSharpTestOracle.FileSuffix + ".")
        Console.WriteLine("  --config <name>    Build configuration (default: Release).")
        Console.WriteLine("  --manifests <dir>  The migrate run directory; its validation manifests add the evaluated")
        Console.WriteLine("                     MSBuild IsTestProject to the classification (recommended).")
        Console.WriteLine("  --no-build         List already-built test assemblies.")
        Console.WriteLine("  --app <id>         Select an existing app (repeatable); non-test apps need no oracle.")
        Console.WriteLine("  --exclude <path>   Same meaning as for migrate/validate.")
        Console.WriteLine("  --passthrough <path>  Same meaning as for migrate/validate.")
    }
}

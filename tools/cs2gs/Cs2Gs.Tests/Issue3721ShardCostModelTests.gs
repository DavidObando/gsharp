// <copyright file="Issue3721ShardCostModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Text.Json
import Xunit

/// Issue #3721: the self-migration gate's shards are packed by OBSERVED per-app
/// duration, not by a structural proxy. Two properties have to survive that
/// change, and they pull in opposite directions:
/// - the matrix must remain an exact PARTITION of the translated apps — every app scheduled, none
/// scheduled twice — no matter what the cost data says, because a scheduling heuristic that drops an
/// app silently shrinks the gate's denominator, which is the failure mode #3668 exists to end;
/// - and the cost data must actually be used, or the rebalance is decoration.
/// The generator is exercised as the workflow runs it — a real process over a
/// real run directory — so a change to its argument surface fails here rather
/// than at 01:23 in the nightly.
open class Issue3721ShardCostModelTests {
    /// Whatever the cost data says, the emitted matrix covers every translated
    /// app exactly once, and never schedules an app that failed translate.
    /// @param withCosts Whether a duration map is supplied.
    @Theory
    @InlineData(true)
    @InlineData(false)
    func MatrixPartitionsTheTranslatedApps(withCosts bool) {
        using let temp = Issue3721ShardCostModelTests.TempDirectory()
        let runDir = WriteRun(temp.Path, TranslatedApps, untranslated: "src/Broken/Broken.csproj")
        let costs = if withCosts {
            WriteCosts(
                temp.Path,
                Dictionary[string, float64]{
                    ["src/Heavy/Heavy.csproj"] = 2400.0,
                    ["src/Medium/Medium.csproj"] = 300.0,
                    ["src/Small1/Small1.csproj"] = 10.0
                }
            )
        } else {
            Path.Combine(temp.Path, "no-such-costs.json")
        }
        let shards = RunGenerator(runDir, shards: 4, costs)
        let scheduled = shards.SelectMany(
            func (shard[]string) IEnumerable[string] {
                return shard
            }
        )
            .ToArray()
        Assert.Equal(scheduled.Length, scheduled.Distinct().Count())
        Assert.Equal(
            TranslatedApps.OrderBy((a string) -> a, StringComparer.Ordinal),
            scheduled.OrderBy((a string) -> a, StringComparer.Ordinal)
        )
        Assert.DoesNotContain("src/Broken/Broken.csproj", scheduled)
    }

    /// The duration map decides the packing: an app that costs more than a
    /// whole other shard's worth of apps gets scheduled alone, which is exactly
    /// what the structural proxy could not express (run 33433830972 gave
    /// `Cs2Gs.Tests` — 44 minutes of test-parity — the same weight class
    /// as libraries that finish in seconds).
    @Fact
    func ExpensiveAppsAreIsolatedByTheDurationMap() {
        using let temp = Issue3721ShardCostModelTests.TempDirectory()
        let runDir = WriteRun(temp.Path, TranslatedApps, untranslated: nil)
        let costs = WriteCosts(
            temp.Path,
            Dictionary[string, float64]{
                ["src/Heavy/Heavy.csproj"] = 2400.0,
                ["src/Medium/Medium.csproj"] = 300.0,
                ["src/Small1/Small1.csproj"] = 10.0,
                ["src/Small2/Small2.csproj"] = 10.0,
                ["src/Small3/Small3.csproj"] = 10.0
            }
        )
        let shards = RunGenerator(runDir, shards: 2, costs)
        let heavyShard = shards.Single((shard[]string) -> shard.Contains("src/Heavy/Heavy.csproj"))
        Assert.Equal([]string{"src/Heavy/Heavy.csproj"}, heavyShard)
    }

    /// A missing or corrupt duration map degrades to the structural proxy
    /// rather than failing the run. The map is a scheduling hint; the gate must
    /// never be blocked by the absence of a hint.
    /// @param contents What sits where the duration map should be.
    @Theory
    @InlineData("")
    @InlineData("not json at all")
    @InlineData("{\"schema\":1}")
    @InlineData("{\"schema\":1,\"apps\":[]}")
    func ACorruptDurationMapDegradesToTheProxy(contents string) {
        using let temp = Issue3721ShardCostModelTests.TempDirectory()
        let runDir = WriteRun(temp.Path, TranslatedApps, untranslated: nil)
        let costs = Path.Combine(temp.Path, "costs.json")
        File.WriteAllText(costs, contents)
        let shards = RunGenerator(runDir, shards: 3, costs)
        Assert.Equal(
            TranslatedApps.OrderBy((a string) -> a, StringComparer.Ordinal),
            shards.SelectMany(
                func (shard[]string) IEnumerable[string] {
                    return shard
                }
            )
                .OrderBy((a string) -> a, StringComparer.Ordinal)
        )
    }

    /// The checked-in duration map is the seed the very first run packs with,
    /// so a hand-edit that breaks its shape must fail here and not silently
    /// return the gate to count-based balancing.
    @Fact
    func TheCheckedInDurationMapIsWellFormed() {
        let path = Path.Combine(RepoRoot(), "build", "selfmig-shard-costs.json")
        using let document = JsonDocument.Parse(File.ReadAllText(path))
        Assert.Equal(1, document.RootElement.GetProperty("schema").GetInt32())
        let apps = document.RootElement.GetProperty("apps")
        Assert.Equal(JsonValueKind.Object, apps.ValueKind)
        var priced = 0
        for app in apps.EnumerateObject() {
            Assert.EndsWith(".csproj", app.Name, StringComparison.Ordinal)
            // Shard app lists are space-separated on the command line.
            Assert.DoesNotContain(' ', app.Name)
            Assert.True(app.Value.GetDouble() >= float64(0.0), app.Name + " has a negative duration.")
            priced++
        }
        Assert.True(priced > 20, "The seeded duration map priced only " + priced.ToString() + " apps.")
    }

    private class TempDirectory : IDisposable {
        init() {
            this.Path = Path.Combine(Path.GetTempPath(), "cs2gs-3721-" + Guid.NewGuid().ToString("n"))
            Directory.CreateDirectory(this.Path)
        }

        prop Path string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(this.Path, recursive: true)
            } catch (IOException) {
                // Best-effort cleanup.

            }
        }
    }

    shared {
        private let TranslatedApps[]string = []string{
            "src/Heavy/Heavy.csproj",
            "src/Medium/Medium.csproj",
            "src/Small1/Small1.csproj",
            "src/Small2/Small2.csproj",
            "src/Small3/Small3.csproj"
        }

        /// Writes a migrate run directory the generator can read.
        /// @param root The temporary root.
        /// @param translated Apps whose translate stage passed.
        /// @param untranslated An app whose translate stage failed, or null.
        /// @returns The run directory path.
        private func WriteRun(root string, translated IReadOnlyList[string], untranslated string?) string {
            let runDir = Path.Combine(root, "run")
            Directory.CreateDirectory(runDir)
            let apps = List[string]()
            var index = 0
            for appId in translated {
                apps.Add(AppJson(appId, "passed"))
                WriteManifest(runDir, "app" + index.ToString(CultureInfo.InvariantCulture), appId)
                index++
            }
            if untranslated != nil {
                apps.Add(AppJson(untranslated, "failed"))
                WriteManifest(runDir, "app" + index.ToString(CultureInfo.InvariantCulture), untranslated)
            }
            File.WriteAllText(
                Path.Combine(runDir, "run.json"),
                "{\"runId\":\"r\",\"timestamp\":\"t\",\"gscVersion\":\"v\",\"gscPath\":\"p\"," +
                    "\"succeeded\":true,\"apps\":[" +
                    string.Join(",", apps) + "]}"
            )
            return runDir
        }

        private func AppJson(appId string, translateStatus string) string -> "{\"appId\":\"" +
            appId +
            "\",\"succeeded\":true,\"stages\":[{\"stage\":\"translate\"," +
            "\"status\":\"" +
            translateStatus +
            "\",\"artifactCount\":0}],\"artifacts\":[],\"fingerprints\":[]}"

        private func WriteManifest(runDir string, dirName string, appId string) {
            let dir = Path.Combine(runDir, dirName)
            Directory.CreateDirectory(dir)
            File.WriteAllText(
                Path.Combine(dir, "validation-context.json"),
                "{\"appId\":\"" + appId + "\",\"emittedFiles\":[\"a.gs\"],\"isTestProject\":false}"
            )
        }

        private func WriteCosts(root string, costs IReadOnlyDictionary[string, float64]) string {
            let path = Path.Combine(root, "costs.json")
            let entries = costs.Select(
                (pair KeyValuePair[string, float64]) -> (
                    "\"" + pair.Key + "\":" + pair.Value.ToString(CultureInfo.InvariantCulture)
                )
            )
            File.WriteAllText(path, "{\"schema\":1,\"apps\":{" + string.Join(",", entries) + "}}")
            return path
        }

        /// Runs the generator exactly as the workflow does.
        /// @param runDir The migrate run directory.
        /// @param shards The requested shard count.
        /// @param costs The duration map path.
        /// @returns One string array of app ids per emitted shard.
        private func RunGenerator(runDir string, shards int32, costs string) List[[]string] {
            let script = Path.Combine(RepoRoot(), "build", "generate-selfmig-shard-matrix.py")
            let startInfo = ProcessStartInfo("python3"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.ArgumentList.Add(script)
            startInfo.ArgumentList.Add("--run-dir")
            startInfo.ArgumentList.Add(runDir)
            startInfo.ArgumentList.Add("--shards")
            startInfo.ArgumentList.Add(shards.ToString(CultureInfo.InvariantCulture))
            startInfo.ArgumentList.Add("--costs")
            startInfo.ArgumentList.Add(costs)
            using let process Process? = Process.Start(startInfo)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.True(process!!.ExitCode == 0, "generate-selfmig-shard-matrix.py failed: " + stderr)
            using let document = JsonDocument.Parse(stdout)
            return document
                .RootElement
                .GetProperty("include")
                .EnumerateArray()
                .Select(
                func (entry JsonElement)[]string {
                    return entry.GetProperty("apps").GetString()!!.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                }
            )
                .ToList()
        }

        private func RepoRoot() string {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil && !Directory.Exists(Path.Combine(dir.FullName, "build")) {
                dir = dir.Parent
            }
            Assert.NotNull(dir)
            return dir!!.FullName
        }
    }
}

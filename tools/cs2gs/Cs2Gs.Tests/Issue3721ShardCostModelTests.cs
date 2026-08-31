// <copyright file="Issue3721ShardCostModelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3721: the self-migration gate's shards are packed by OBSERVED per-app
/// duration, not by a structural proxy. Two properties have to survive that
/// change, and they pull in opposite directions:
/// <list type="bullet">
/// <item><description>
/// the matrix must remain an exact PARTITION of the translated apps — every
/// app scheduled, none scheduled twice — no matter what the cost data says,
/// because a scheduling heuristic that drops an app silently shrinks the
/// gate's denominator, which is the failure mode #3668 exists to end;
/// </description></item>
/// <item><description>
/// and the cost data must actually be used, or the rebalance is decoration.
/// </description></item>
/// </list>
/// The generator is exercised as the workflow runs it — a real process over a
/// real run directory — so a change to its argument surface fails here rather
/// than at 01:23 in the nightly.
/// </summary>
public class Issue3721ShardCostModelTests
{
    /// <summary>
    /// Whatever the cost data says, the emitted matrix covers every translated
    /// app exactly once, and never schedules an app that failed translate.
    /// </summary>
    /// <param name="withCosts">Whether a duration map is supplied.</param>
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void MatrixPartitionsTheTranslatedApps(bool withCosts)
    {
        using var temp = new TempDirectory();
        string runDir = WriteRun(temp.Path, TranslatedApps, untranslated: "src/Broken/Broken.csproj");
        string costs = withCosts
            ? WriteCosts(temp.Path, new Dictionary<string, double>
            {
                ["src/Heavy/Heavy.csproj"] = 2400,
                ["src/Medium/Medium.csproj"] = 300,
                ["src/Small1/Small1.csproj"] = 10,
            })
            : Path.Combine(temp.Path, "no-such-costs.json");

        List<string[]> shards = RunGenerator(runDir, shards: 4, costs);
        string[] scheduled = shards.SelectMany(shard => shard).ToArray();

        Assert.Equal(scheduled.Length, scheduled.Distinct().Count());
        Assert.Equal(TranslatedApps.OrderBy(a => a, StringComparer.Ordinal), scheduled.OrderBy(a => a, StringComparer.Ordinal));
        Assert.DoesNotContain("src/Broken/Broken.csproj", scheduled);
    }

    /// <summary>
    /// The duration map decides the packing: an app that costs more than a
    /// whole other shard's worth of apps gets scheduled alone, which is exactly
    /// what the structural proxy could not express (run 33433830972 gave
    /// <c>Cs2Gs.Tests</c> — 44 minutes of test-parity — the same weight class
    /// as libraries that finish in seconds).
    /// </summary>
    [Fact]
    public void ExpensiveAppsAreIsolatedByTheDurationMap()
    {
        using var temp = new TempDirectory();
        string runDir = WriteRun(temp.Path, TranslatedApps, untranslated: null);
        string costs = WriteCosts(temp.Path, new Dictionary<string, double>
        {
            ["src/Heavy/Heavy.csproj"] = 2400,
            ["src/Medium/Medium.csproj"] = 300,
            ["src/Small1/Small1.csproj"] = 10,
            ["src/Small2/Small2.csproj"] = 10,
            ["src/Small3/Small3.csproj"] = 10,
        });

        List<string[]> shards = RunGenerator(runDir, shards: 2, costs);

        string[] heavyShard = shards.Single(shard => shard.Contains("src/Heavy/Heavy.csproj"));
        Assert.Equal(new[] { "src/Heavy/Heavy.csproj" }, heavyShard);
    }

    /// <summary>
    /// A missing or corrupt duration map degrades to the structural proxy
    /// rather than failing the run. The map is a scheduling hint; the gate must
    /// never be blocked by the absence of a hint.
    /// </summary>
    /// <param name="contents">What sits where the duration map should be.</param>
    [Theory]
    [InlineData("")]
    [InlineData("not json at all")]
    [InlineData("{\"schema\":1}")]
    [InlineData("{\"schema\":1,\"apps\":[]}")]
    public void ACorruptDurationMapDegradesToTheProxy(string contents)
    {
        using var temp = new TempDirectory();
        string runDir = WriteRun(temp.Path, TranslatedApps, untranslated: null);
        string costs = Path.Combine(temp.Path, "costs.json");
        File.WriteAllText(costs, contents);

        List<string[]> shards = RunGenerator(runDir, shards: 3, costs);

        Assert.Equal(
            TranslatedApps.OrderBy(a => a, StringComparer.Ordinal),
            shards.SelectMany(shard => shard).OrderBy(a => a, StringComparer.Ordinal));
    }

    /// <summary>
    /// The checked-in duration map is the seed the very first run packs with,
    /// so a hand-edit that breaks its shape must fail here and not silently
    /// return the gate to count-based balancing.
    /// </summary>
    [Fact]
    public void TheCheckedInDurationMapIsWellFormed()
    {
        string path = Path.Combine(RepoRoot(), "build", "selfmig-shard-costs.json");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));

        Assert.Equal(1, document.RootElement.GetProperty("schema").GetInt32());
        JsonElement apps = document.RootElement.GetProperty("apps");
        Assert.Equal(JsonValueKind.Object, apps.ValueKind);

        int priced = 0;
        foreach (JsonProperty app in apps.EnumerateObject())
        {
            Assert.EndsWith(".csproj", app.Name, StringComparison.Ordinal);
            // Shard app lists are space-separated on the command line.
            Assert.DoesNotContain(' ', app.Name);
            Assert.True(app.Value.GetDouble() >= 0, app.Name + " has a negative duration.");
            priced++;
        }

        Assert.True(priced > 20, "The seeded duration map priced only " + priced + " apps.");
    }

    private static readonly string[] TranslatedApps =
    {
        "src/Heavy/Heavy.csproj",
        "src/Medium/Medium.csproj",
        "src/Small1/Small1.csproj",
        "src/Small2/Small2.csproj",
        "src/Small3/Small3.csproj",
    };

    /// <summary>Writes a migrate run directory the generator can read.</summary>
    /// <param name="root">The temporary root.</param>
    /// <param name="translated">Apps whose translate stage passed.</param>
    /// <param name="untranslated">An app whose translate stage failed, or null.</param>
    /// <returns>The run directory path.</returns>
    private static string WriteRun(string root, IReadOnlyList<string> translated, string untranslated)
    {
        string runDir = Path.Combine(root, "run");
        Directory.CreateDirectory(runDir);

        var apps = new List<string>();
        int index = 0;
        foreach (string appId in translated)
        {
            apps.Add(AppJson(appId, "passed"));
            WriteManifest(runDir, "app" + index.ToString(CultureInfo.InvariantCulture), appId);
            index++;
        }

        if (untranslated is not null)
        {
            apps.Add(AppJson(untranslated, "failed"));
            WriteManifest(runDir, "app" + index.ToString(CultureInfo.InvariantCulture), untranslated);
        }

        File.WriteAllText(
            Path.Combine(runDir, "run.json"),
            "{\"runId\":\"r\",\"timestamp\":\"t\",\"gscVersion\":\"v\",\"gscPath\":\"p\"," +
            "\"succeeded\":true,\"apps\":[" + string.Join(",", apps) + "]}");
        return runDir;
    }

    private static string AppJson(string appId, string translateStatus) =>
        "{\"appId\":\"" + appId + "\",\"succeeded\":true,\"stages\":[{\"stage\":\"translate\"," +
        "\"status\":\"" + translateStatus + "\",\"artifactCount\":0}],\"artifacts\":[],\"fingerprints\":[]}";

    private static void WriteManifest(string runDir, string dirName, string appId)
    {
        string dir = Path.Combine(runDir, dirName);
        Directory.CreateDirectory(dir);
        File.WriteAllText(
            Path.Combine(dir, "validation-context.json"),
            "{\"appId\":\"" + appId + "\",\"emittedFiles\":[\"a.gs\"],\"isTestProject\":false}");
    }

    private static string WriteCosts(string root, IReadOnlyDictionary<string, double> costs)
    {
        string path = Path.Combine(root, "costs.json");
        IEnumerable<string> entries = costs.Select(pair =>
            "\"" + pair.Key + "\":" + pair.Value.ToString(CultureInfo.InvariantCulture));
        File.WriteAllText(path, "{\"schema\":1,\"apps\":{" + string.Join(",", entries) + "}}");
        return path;
    }

    /// <summary>Runs the generator exactly as the workflow does.</summary>
    /// <param name="runDir">The migrate run directory.</param>
    /// <param name="shards">The requested shard count.</param>
    /// <param name="costs">The duration map path.</param>
    /// <returns>One string array of app ids per emitted shard.</returns>
    private static List<string[]> RunGenerator(string runDir, int shards, string costs)
    {
        string script = Path.Combine(RepoRoot(), "build", "generate-selfmig-shard-matrix.py");
        var startInfo = new ProcessStartInfo("python3")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add("--run-dir");
        startInfo.ArgumentList.Add(runDir);
        startInfo.ArgumentList.Add("--shards");
        startInfo.ArgumentList.Add(shards.ToString(CultureInfo.InvariantCulture));
        startInfo.ArgumentList.Add("--costs");
        startInfo.ArgumentList.Add(costs);

        using Process process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, "generate-selfmig-shard-matrix.py failed: " + stderr);

        using JsonDocument document = JsonDocument.Parse(stdout);
        return document.RootElement.GetProperty("include").EnumerateArray()
            .Select(entry => entry.GetProperty("apps").GetString()
                .Split(' ', StringSplitOptions.RemoveEmptyEntries))
            .ToList();
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "build")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        return dir.FullName;
    }

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            this.Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(), "cs2gs-3721-" + Guid.NewGuid().ToString("n"));
            Directory.CreateDirectory(this.Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(this.Path, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup.
            }
        }
    }
}

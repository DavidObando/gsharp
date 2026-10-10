// <copyright file="Issue4853StopAfterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #4853: <c>cs2gs migrate --stop-after</c> selects a stage prefix.</summary>
public sealed class Issue4853StopAfterTests : IDisposable
{
    private readonly string root =
        Path.Combine(Path.GetTempPath(), "cs2gs-4853-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try
        {
            Directory.Delete(this.root, recursive: true);
        }
        catch (DirectoryNotFoundException)
        {
        }
        catch (IOException)
        {
        }
    }

    [Theory]
    [InlineData("translate", new[] { "translate" })]
    [InlineData("compile", new[] { "translate", "compile" })]
    [InlineData("ilverify", new[] { "translate", "compile", "ilverify" })]
    [InlineData("test-parity", new[] { "translate", "compile", "ilverify", "test-parity" })]
    public void StopAfter_ParsesToTheStagePrefix(string name, string[] expected)
    {
        object parsed = Parse("--corpus", "/nonexistent-corpus", "--stop-after", name);

        Assert.NotNull(parsed);
        var stopAfter = (MigrationStageKind?)parsed.GetType().GetProperty("StopAfter").GetValue(parsed);
        Assert.Equal(
            expected,
            MigrationPipeline.StagesThrough(stopAfter.Value)
                .Select(stage => TriageSerialization.StageName(stage.Kind))
                .ToArray());
    }

    [Fact]
    public void StopAfter_DefaultsToAllStages()
    {
        object parsed = Parse("--corpus", "/nonexistent-corpus");

        Assert.NotNull(parsed);
        Assert.Null((MigrationStageKind?)parsed.GetType().GetProperty("StopAfter").GetValue(parsed));
    }

    [Theory]
    [InlineData("compile", true)]
    [InlineData("ilverify", true)]
    [InlineData("test-parity", true)]
    [InlineData("translate", false)]
    public void TranslateOnly_ConflictsWithALaterStopAfter(string stage, bool rejected)
    {
        object parsed = Parse("--corpus", "/nonexistent-corpus", "--translate-only", "--stop-after", stage);

        Assert.Equal(rejected, parsed is null);
    }

    [Fact]
    public void StopAfter_RejectsAnUnknownStage()
    {
        Assert.Null(Parse("--corpus", "/nonexistent-corpus", "--stop-after", "polish"));
    }

    /// <summary>
    /// The real driver: <c>migrate --stop-after translate</c> runs exactly the
    /// translate stage for each app (a regression that ignores the option would
    /// also record compile and later stages).
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Migrate_StopAfterTranslate_RunsOnlyTheTranslateStage()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string source = Path.Combine(this.root, "source", "src", "Widget");
        Directory.CreateDirectory(source);
        File.WriteAllText(
            Path.Combine(source, "Widget.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
        File.WriteAllText(
            Path.Combine(source, "Widget.cs"),
            "namespace Widget { public static class Answer { public static int Value() => 42; } }");
        string artifacts = Path.Combine(this.root, "runs");

        int exit = await Cs2Gs.Cli.Program.Main(new[]
        {
            "migrate",
            "--corpus", Path.Combine(this.root, "source"),
            "--out", Path.Combine(this.root, "destination"),
            "--artifacts", artifacts,
            "--gsc", compiler,
            "--config", "Release",
            "--stop-after", "translate",
        });

        string runJson = Directory.GetFiles(artifacts, "run.json", SearchOption.AllDirectories).Single();
        RunResult result = JsonSerializer.Deserialize<RunResult>(File.ReadAllText(runJson), TriageSerialization.Options);
        AppResult app = Assert.Single(result.Apps);
        Assert.Equal(new[] { "translate" }, app.Stages.Select(stage => stage.Stage).ToArray());
        Assert.Equal(0, exit);
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static object Parse(params string[] args)
    {
        MethodInfo parse = typeof(Cs2Gs.Cli.Program).GetMethod(
            "ParseMigrateArgs",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(parse);
        return parse.Invoke(null, new object[] { args, false });
    }
}

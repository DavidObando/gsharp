// <copyright file="Issue2579NullableReferenceFidelityPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2579NullableReferenceFidelityPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdk_ObliviousProducerReturns_AreForgivenAtConsumerUses()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("oblivious-projects");
        (string producerProject, string consumerProject) = WriteObliviousFixture(sourceRoot);
        RunDotnetBuild(producerProject);
        string outputRoot = NewDirectory("oblivious-pipeline-tests");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2579Oblivious", consumerProject, TargetKind.Library) });
        AppResult app = Assert.Single(result.Apps);
        string emitted = ReadAppOutput(outputRoot, result.RunId, app.AppId);

        Assert.Contains("Factory.GetItem()!!.Next!!.Name", emitted, StringComparison.Ordinal);
        Assert.Contains("Factory.GetItem()!!.Label()", emitted, StringComparison.Ordinal);
        Assert.Contains("Repro.Consume(Factory.GetItem()!!)", emitted, StringComparison.Ordinal);
        Assert.Contains("Repro.Required = Factory.GetItem()!!", emitted, StringComparison.Ordinal);
        Assert.Contains("Factory.GetMap()!![Factory.GetKey()!!]", emitted, StringComparison.Ordinal);
        Assert.Contains("for item in Factory.GetItems()!!", emitted, StringComparison.Ordinal);
        Assert.True(
            app.Succeeded,
            "Expected nullable-enabled consumers of nullable-disabled producers to compile via gsc. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    [Fact]
    public async Task Pipeline_ViaSdk_NullableWarningBoundaries_TranslateAndCompile()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        string projectPath = WriteFixture(sourceRoot);
        string outputRoot = NewDirectory("pipeline-tests");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2579", projectPath, TargetKind.Library) });
        AppResult app = Assert.Single(result.Apps);
        string emitted = ReadAppOutput(outputRoot, result.RunId, app.AppId);

        Assert.Contains("item!!.Next!!.Name", emitted, StringComparison.Ordinal);
        Assert.Contains("item!!.Label()", emitted, StringComparison.Ordinal);
        Assert.Contains("items!!.Count()", emitted, StringComparison.Ordinal);
        Assert.Contains("for current in items!!", emitted, StringComparison.Ordinal);
        Assert.Contains("var required = key!!", emitted, StringComparison.Ordinal);
        Assert.Contains("required = key!!", emitted, StringComparison.Ordinal);
        Assert.Contains("Repro.Required = key!!", emitted, StringComparison.Ordinal);
        Assert.Contains("Repro.Consume(key!!)", emitted, StringComparison.Ordinal);
        Assert.Contains("map_[key!!]", emitted, StringComparison.Ordinal);
        Assert.True(
            app.Succeeded,
            "Expected nullable-enabled warning boundaries to compile via gsc. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "Issue2579");
        Directory.CreateDirectory(projectDir);

        string projectPath = Path.Combine(projectDir, "Issue2579.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), """
            using System.Collections.Generic;
            using System.Linq;

            namespace Issue2579;

            public sealed class Item
            {
                public string Name => "item";
                public Item? Next => null;
            }

            public static class ItemExtensions
            {
                public static string Label(this Item item) => item.Name;
            }

            public static class Repro
            {
                private static string Required = "";
                private static void Consume(string value) { }

                public static int Run(
                    Item? item,
                    IEnumerable<Item>? items,
                    Dictionary<string, string> map,
                    string? key)
                {
                    _ = item.Next.Name;
                    _ = item.Label();
                    _ = items.Count();
                    foreach (var current in items)
                        _ = current.Name;
                    string required = key;
                    required = key;
                    Required = key;
                    Consume(key);
                    _ = map[key];
                    return required.Length;
                }
            }
            """);
        return projectPath;
    }

    private static (string ProducerProject, string ConsumerProject) WriteObliviousFixture(
        string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string producerDir = Path.Combine(sourceRoot, "Producer");
        string consumerDir = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(producerDir);
        Directory.CreateDirectory(consumerDir);

        string producerProject = Path.Combine(producerDir, "Producer.csproj");
        File.WriteAllText(producerProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(producerDir, "Producer.cs"), """
            using System.Collections.Generic;

            namespace ObliviousProducer;

            public sealed class Item
            {
                public string Name => "item";
                public Item Next => this;
            }

            public static class Factory
            {
                public static Item GetItem() => new();
                public static IEnumerable<Item> GetItems() => new[] { new Item() };
                public static Dictionary<string, Item> GetMap() =>
                    new() { ["key"] = new Item() };
                public static string GetKey() => "key";
            }
            """);

        string consumerProject = Path.Combine(consumerDir, "Consumer.csproj");
        File.WriteAllText(consumerProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
              <ItemGroup>
                <ProjectReference Include="../Producer/Producer.csproj" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(consumerDir, "Consumer.cs"), """
            using ObliviousProducer;

            namespace Issue2579Oblivious;

            public static class ItemExtensions
            {
                public static string Label(this Item item) => item.Name;
            }

            public static class Repro
            {
                private static Item Required = new();
                private static void Consume(Item item) { }

                public static int Run()
                {
                    _ = Factory.GetItem().Next.Name;
                    _ = Factory.GetItem().Label();
                    Consume(Factory.GetItem());
                    Required = Factory.GetItem();
                    _ = Factory.GetMap()[Factory.GetKey()].Name;
                    foreach (var item in Factory.GetItems())
                        _ = item.Name;
                    return Required.Name.Length;
                }
            }
            """);

        return (producerProject, consumerProject);
    }

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo(
            "dotnet",
            $"build \"{projectPath}\" --nologo --verbosity:quiet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1";

        using var process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, "Failed to prebuild producer project:\n" + stdout + stderr);
    }

    private static string ReadAppOutput(string outputRoot, string runId, string appId)
    {
        string directory = Path.Combine(outputRoot, runId, MigrationPipeline.SanitizeAppId(appId));
        return string.Join(
            Environment.NewLine,
            Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2579",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    projectDirName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}

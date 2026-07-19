// <copyright file="Issue2496ExpressionTreeArgumentForgivenessPipelineTests.cs" company="GSharp">
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

/// <summary>
/// End-to-end default <c>--via-sdk</c> coverage for issue #2496 using an
/// oblivious sibling assembly that exposes EF-style expression-tree sinks.
/// </summary>
public sealed class Issue2496ExpressionTreeArgumentForgivenessPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_ObliviousExpressionSinks_TranslateAndCompile()
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
        (string apiProject, string appProject) = WriteFixture(sourceRoot);
        RunDotnetBuild(apiProject);

        string outputRoot = NewDirectory("pipeline-tests");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };
        Assert.True(options.CompileViaSdk);

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/ExpressionConsumer", appProject, TargetKind.Library) });
        AppResult appResult = Assert.Single(result.Apps);

        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(appResult.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("HasKey((item Item) -> item.Id)", emitted, StringComparison.Ordinal);
        Assert.Contains("HasIndex((item Item) -> item.Name)", emitted, StringComparison.Ordinal);
        Assert.Contains("HasForeignKey((item Item) ->", emitted, StringComparison.Ordinal);
        Assert.Contains("Runtime((item Item) -> item.Name!!)", emitted, StringComparison.Ordinal);
        Assert.Contains("Selector[Item]((item Item) -> item.Id)", emitted, StringComparison.Ordinal);
        Assert.Contains("OverloadSink.Select", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("item.Id!!", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("item.ParentId!!", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("child.Name!!", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept all expression-tree sinks. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static (string ApiProject, string AppProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string apiDir = Path.Combine(sourceRoot, "Api");
        string appDir = Path.Combine(sourceRoot, "ExpressionConsumer");
        Directory.CreateDirectory(apiDir);
        Directory.CreateDirectory(appDir);

        string apiProject = Path.Combine(apiDir, "Api.csproj");
        File.WriteAllText(apiProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(apiDir, "Api.cs"), """
            using System;
            using System.Linq.Expressions;

            namespace ExpressionApi;

            public sealed class ModelBuilder
            {
                public EntityBuilder<T> Entity<T>() => new();
            }

            public sealed class EntityBuilder<T>
            {
                public EntityBuilder<T> HasKey(Expression<Func<T, object>> selector) => this;
                public EntityBuilder<T> HasIndex(Expression<Func<T, string>> selector) => this;
                public EntityBuilder<T> HasForeignKey(Expression<Func<T, object>> selector) => this;
                public EntityBuilder<T> Runtime(Func<T, string> selector) => this;
            }

            public sealed class Selector<T>
            {
                public Selector(Expression<Func<T, object>> selector) { }
            }

            public static class OverloadSink
            {
                public static void Select<T>(Expression<Func<T, string>> selector) { }
                public static void Select<T>(Func<T, int> selector) { }
            }
            """);

        string appProject = Path.Combine(appDir, "ExpressionConsumer.csproj");
        File.WriteAllText(appProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
              <ItemGroup>
                <ProjectReference Include="../Api/Api.csproj" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(appDir, "Model.cs"), """
            using ExpressionApi;

            namespace ExpressionConsumer;

            public sealed class Item
            {
                public int Id { get; set; }
                public int? ParentId { get; set; }
                public Item Other { get; set; }
                public string Name => Other?.Name;
            }

            public sealed class Context
            {
                public void Configure(ModelBuilder modelBuilder)
                {
                    modelBuilder.Entity<Item>()
                        .HasKey(item => item.Id)
                        .HasIndex(item => item.Name)
                        .HasForeignKey(item => new { item.Id, item.ParentId })
                        .Runtime(item => item.Name);

                    _ = new Selector<Item>(item => item.Id);
                    OverloadSink.Select((Item item) => item.Name);
                    OverloadSink.Select((Item item) => item.Id);
                }
            }
            """);

        return (apiProject, appProject);
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
        Assert.True(
            process.ExitCode == 0,
            "Failed to prebuild expression sink project:\n" + stdout + stderr);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2496",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    dir.FullName,
                    "out",
                    "bin",
                    config,
                    projectDirName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}

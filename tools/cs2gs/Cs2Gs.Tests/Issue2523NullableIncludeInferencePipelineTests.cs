// <copyright file="Issue2523NullableIncludeInferencePipelineTests.cs" company="GSharp">
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
/// Default SDK-backed two-project EF coverage for issue #2523.
/// </summary>
public sealed class Issue2523NullableIncludeInferencePipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_TwoProjectNullableIncludeChainsCompile()
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
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string dataDir = Path.Combine(sourceRoot, "Data");
        string consumerDir = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(dataDir);
        Directory.CreateDirectory(consumerDir);

        string dataProject = Path.Combine(dataDir, "Data.csproj");
        File.WriteAllText(dataProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.0" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(dataDir, "Model.cs"), """
            using System.Collections.Generic;
            using Microsoft.EntityFrameworkCore;

            namespace Data;

            public sealed class Child { }
            public sealed class Other { }
            public sealed class Conversion { }

            public sealed class Component
            {
                public Conversion? Conversion { get; set; }
            }

            public sealed class Entity
            {
                public Child? Child { get; set; }
                public Other? Other { get; set; }
            }

            public sealed class Book
            {
                public Conversion? Conversion { get; set; }
                public List<Component> Components { get; set; } = [];
                public Other? Other { get; set; }
            }

            public sealed class Context : DbContext
            {
                public DbSet<Entity> Entities { get; set; } = null!;
                public DbSet<Book> Books { get; set; } = null!;
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
                <ProjectReference Include="../Data/Data.csproj" />
                <PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.0" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(consumerDir, "Query.cs"), """
            using System.Linq;
            using Data;
            using Microsoft.EntityFrameworkCore;

            namespace Consumer;

            public static class Query
            {
                public static IQueryable<Entity> Minimal(Context context) =>
                    context.Entities
                        .Include((Entity entity) => entity.Child)
                        .Include((Entity entity) => entity.Other);

                public static IQueryable<Book> OahuShape(Context context) =>
                    context.Books
                        .Include((Book book) => book.Conversion)
                        .Include((Book book) => book.Components)
                        .ThenInclude((Component component) => component.Conversion)
                        .Include((Book book) => book.Other);
            }
            """);
        RunDotnetBuild(dataProject);

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp(
            "test/NullableIncludeInference",
            consumerProject,
            TargetKind.Library);
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
        RunResult result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/NullableIncludeData", dataProject, TargetKind.Library),
            app,
        });
        Assert.All(
            result.Apps,
            current => Assert.True(
                current.Succeeded,
                current.AppId + " should compile through default --via-sdk/gsc. Stages: "
                    + string.Join("; ", current.Stages.Select(stage => stage.Stage + "=" + stage.Status))));
        AppResult appResult = result.Apps.Single(current => current.AppId == app.Id);

        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.Id));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains(".Include(", emitted, StringComparison.Ordinal);
        Assert.Contains(".ThenInclude(", emitted, StringComparison.Ordinal);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2523",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
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

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start the issue #2523 data build.");
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(
            process.ExitCode == 0,
            "Failed to prebuild the issue #2523 data project:\n" + stdout + stderr);
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

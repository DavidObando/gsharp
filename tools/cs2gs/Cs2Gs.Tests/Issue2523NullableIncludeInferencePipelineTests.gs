// <copyright file="Issue2523NullableIncludeInferencePipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Default SDK-backed two-project EF coverage for issue #2523.
class Issue2523NullableIncludeInferencePipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_TwoProjectNullableIncludeChainsCompile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let dataDir = Path.Combine(sourceRoot, "Data")
        let consumerDir = Path.Combine(sourceRoot, "Consumer")
        Directory.CreateDirectory(dataDir)
        Directory.CreateDirectory(consumerDir)
        let dataProject = Path.Combine(dataDir, "Data.csproj")
        File.WriteAllText(dataProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.0" />
  </ItemGroup>
</Project>`)
        File.WriteAllText(Path.Combine(dataDir, "Model.cs"), `using System.Collections.Generic;
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
    public ICollection<Component> Components { get; set; } = [];
    public Other? Other { get; set; }
}

public sealed class Context : DbContext
{
    public DbSet<Entity> Entities { get; set; } = null!;
    public DbSet<Book> Books { get; set; } = null!;
}`)
        let consumerProject = Path.Combine(consumerDir, "Consumer.csproj")
        File.WriteAllText(consumerProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Data/Data.csproj" />
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="10.0.0" />
  </ItemGroup>
</Project>`)
        File.WriteAllText(Path.Combine(consumerDir, "Query.cs"), `using System.Linq;
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
}`)
        RunDotnetBuild(dataProject)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/NullableIncludeInference", consumerProject, TargetKind.Library)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync(
            []CorpusApp{CorpusApp("test/NullableIncludeData", dataProject, TargetKind.Library), app}
        )
        Assert.All(
            result.Apps,
            (current AppResult) -> Assert.True(
                current.Succeeded,
                current.AppId + " should compile through default --via-sdk/gsc. Stages: " + string.Join(
                    "; ",
                    current.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                )
            )
        )
        let appResult = result.Apps.Single((current AppResult) -> current.AppId == app.Id)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains(".Include(", emitted, StringComparison.Ordinal)
        Assert.Contains(".ThenInclude(", emitted, StringComparison.Ordinal)
    }

    shared {
        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2523", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func RunDotnetBuild(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet", "build \"$projectPath\" --nologo --verbosity:quiet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1"
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start the issue #2523 data build.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            process.WaitForExit()
            Assert.True(process.ExitCode == 0, "Failed to prebuild the issue #2523 data project:\n" + stdout + stderr)
        }

        private func FindSiblingTool(projectDirName string, dllName string) string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(
                        directory.FullName,
                        "out",
                        "bin",
                        configuration,
                        projectDirName,
                        dllName
                    )
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}

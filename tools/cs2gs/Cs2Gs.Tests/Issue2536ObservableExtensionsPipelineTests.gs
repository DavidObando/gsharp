// <copyright file="Issue2536ObservableExtensionsPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue2536ObservableExtensionsPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_ObservableAndInheritedInterfaceLinqExtensions_Compile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let (contractsProject, consumerProject) = WriteFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync(
            []CorpusApp{
                CorpusApp("test/Contracts", contractsProject, TargetKind.Library),
                CorpusApp("test/Consumer", consumerProject, TargetKind.Library)
            }
        )
        Assert.All(
            result.Apps,
            (app AppResult) -> Assert.True(
                app.Succeeded,
                app.AppId + " should compile through default --via-sdk/gsc. Stages: " + string.Join(
                    "; ",
                    app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                )
            )
        )
    }

    shared {
        private func WriteFixture(sourceRoot string)(ContractsProject string, ConsumerProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let contractsDirectory = Path.Combine(sourceRoot, "Contracts")
            Directory.CreateDirectory(contractsDirectory)
            let contractsProject = Path.Combine(contractsDirectory, "Contracts.csproj")
            File.WriteAllText(contractsProject, ProjectFile(nil))
            File.WriteAllText(Path.Combine(contractsDirectory, "Contracts.cs"), `using System.Collections.Generic;
using System.IO;

namespace Issue2536.Contracts;

public sealed class Model
{
    public int Value { get; set; }
}

public interface IModels : IReadOnlyCollection<Model>
{
}

public static class StreamExtensions
{
    public static long Remaining(this Stream stream) =>
        stream.Length - stream.Position;
}`)
            let consumerDirectory = Path.Combine(sourceRoot, "Consumer")
            Directory.CreateDirectory(consumerDirectory)
            let consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj")
            File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"))
            File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), `using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using Issue2536.Contracts;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Issue2536.Consumer;

public sealed class LocalModel
{
    public int Value { get; set; }
}

public sealed class LocalStream : MemoryStream { }
public sealed class Factory
{
    public Func<Model> Create { get; } = () => new Model();
}

public static class Repro
{
    public static IEnumerable<Model> Where(ObservableCollection<Model> items) =>
        items.Where(item => item.Value > 0);

    public static bool Any(IModels items) =>
        items.Any(item => item.Value > 0);

    public static int Count(ObservableCollection<Model> items) =>
        items.Count(item => item.Value > 0);

    public static Model? FirstOrDefault(IModels items) =>
        items.FirstOrDefault();

    public static bool LocalAny(ObservableCollection<LocalModel> items) =>
        items.Any(item => item.Value > 0);

    public static int LocalCount(ObservableCollection<LocalModel> items) =>
        items.Count(item => item.Value > 0);

    public static IEnumerable<LocalModel> LocalWhere(ObservableCollection<LocalModel> items) =>
        items.Where(item => item.Value > 0);

    public static LocalModel? LocalFirstOrDefault(ObservableCollection<LocalModel> items) =>
        items.FirstOrDefault();

    public static IServiceCollection Register(IServiceCollection services, Factory factory) =>
        services.AddSingleton(_ => factory.Create());

    public static IApplicationBuilder Use(IApplicationBuilder app) =>
        app.Use(async (context, next) => await next(context));

    public static long StreamBase(LocalStream stream) =>
        stream.Remaining();
}`)
            return (contractsProject, consumerProject)
        }

        private func ProjectFile(projectReference string?) string {
            let reference = if projectReference == nil {
                string.Empty
            } else {
                (`
  <ItemGroup>
    <ProjectReference Include="` + "$projectReference" + `" />
  </ItemGroup>`)
            }
            return (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>` + "$reference" + `
</Project>`)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2536", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirectoryName string, dllName string) string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(
                        directory.FullName,
                        "out",
                        "bin",
                        configuration,
                        projectDirectoryName,
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

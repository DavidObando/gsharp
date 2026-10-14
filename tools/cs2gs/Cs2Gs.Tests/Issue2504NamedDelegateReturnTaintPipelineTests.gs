// <copyright file="Issue2504NamedDelegateReturnTaintPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Default SDK-backed/gsc sink coverage for issue #2504, including the
/// cross-project delegate-declaration/producer shape used by real corpora.
class Issue2504NamedDelegateReturnTaintPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_CrossProjectNamedDelegateReturn_TranslatesAndCompiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let (contractsProject, producerProject) = WriteFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync(
            []CorpusApp{
                CorpusApp("test/Contracts", contractsProject, TargetKind.Library),
                CorpusApp("test/Producer", producerProject, TargetKind.Library)
            }
        )
        Assert.All(
            result.Apps,
            (app AppResult) -> Assert.True(
                app.Succeeded,
                "Expected default --via-sdk/gsc compilation to succeed for ${app.AppId}. Stages: " + string.Join(
                    "; ",
                    app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                )
            )
        )
        let contracts = ReadAppOutput(outputRoot, result.RunId, "test_Contracts")
        let producer = ReadAppOutput(outputRoot, result.RunId, "test_Producer")
        Assert.Contains("class Result", contracts, StringComparison.Ordinal)
        Assert.Contains("delegate Callback(enforce bool = false) Result?;", producer, StringComparison.Ordinal)
        // Issue #2835: `Callback` is source-declared, so it keeps its nominal
        // name; the `Result?` return promotion is carried by the `type Callback`
        // declaration asserted above, and the field keeps its own `?` envelope.
        Assert.Contains("callback Callback?", producer, StringComparison.Ordinal)
        Assert.Contains("func Produce(enforce bool) Result? -> nil", producer, StringComparison.Ordinal)
        Assert.Contains("Holder(Produce)", producer, StringComparison.Ordinal)
        Assert.DoesNotContain("Produce!!", producer, StringComparison.Ordinal)
    }

    shared {
        private func WriteFixture(sourceRoot string)(ContractsProject string, ProducerProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let contractsDir = Path.Combine(sourceRoot, "Contracts")
            Directory.CreateDirectory(contractsDir)
            let contractsProject = Path.Combine(contractsDir, "Contracts.csproj")
            File.WriteAllText(contractsProject, ProjectFile(projectReference: nil))
            File.WriteAllText(Path.Combine(contractsDir, "Contracts.cs"), `namespace Contracts;

public sealed class Result { }`)
            let producerDir = Path.Combine(sourceRoot, "Producer")
            Directory.CreateDirectory(producerDir)
            let producerProject = Path.Combine(producerDir, "Producer.csproj")
            File.WriteAllText(producerProject, ProjectFile(Path.GetRelativePath(producerDir, contractsProject)))
            File.WriteAllText(Path.Combine(producerDir, "Repro.cs"), `using Contracts;

namespace Producer;

public delegate Result Callback(bool enforce = false);

public sealed class Holder
{
    private readonly Callback callback;

    public Holder(Callback callback) => this.callback = callback;

    public Result Run(bool enforce = false) => callback?.Invoke(enforce);
}

public static class Repro
{
    private static Result Produce(bool enforce) => null;

    public static Holder Create() => new Holder(Produce);
}`)
            return (contractsProject, producerProject)
        }

        private func ProjectFile(projectReference string?) string -> if projectReference == nil {
            `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`
        } else {
            (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="` + "$projectReference" + `" />
  </ItemGroup>
</Project>`)
        }

        private func ReadAppOutput(outputRoot string, runId string, appDirectory string) string {
            let directory = Path.Combine(outputRoot, runId, appDirectory)
            return string.Join(
                Environment.NewLine,
                Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
            )
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2504", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
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

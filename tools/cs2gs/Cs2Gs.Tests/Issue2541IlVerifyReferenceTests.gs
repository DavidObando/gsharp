// <copyright file="Issue2541IlVerifyReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Regression coverage for ILVerify reference resolution in multi-project migrations.
class Issue2541IlVerifyReferenceTests {
    @Fact
    async func Pipeline_SafeProjectReference_PassesIlVerify() {
        let compiler string? = FindCompiler()
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil ||
            !IlVerifyToolAvailable() {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let (contractsProject, consumerProject) = WriteFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage()}
        )
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
                app.AppId + " should pass ILVerify. Stages: " + string.Join(
                    "; ",
                    app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                )
            )
        )
        Assert.All(result.Apps, (app AppResult) -> Assert.Equal("passed", app.Stages[2].Status))
    }

    shared {
        private func WriteFixture(sourceRoot string)(ContractsProject string, ConsumerProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let contractsDir = Path.Combine(sourceRoot, "Contracts")
            Directory.CreateDirectory(contractsDir)
            let contractsProject = Path.Combine(contractsDir, "Contracts.csproj")
            File.WriteAllText(contractsProject, ProjectFile(nil))
            File.WriteAllText(Path.Combine(contractsDir, "Greeter.cs"), `namespace Contracts;

public sealed class Greeter
{
    public string Greet(string name) => "Hello, " + name;
}`)
            let consumerDir = Path.Combine(sourceRoot, "Consumer")
            Directory.CreateDirectory(consumerDir)
            let consumerProject = Path.Combine(consumerDir, "Consumer.csproj")
            File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"))
            File.WriteAllText(Path.Combine(consumerDir, "Welcome.cs"), `using Contracts;

namespace Consumer;

public static class Welcome
{
    public static string Message(string name) => new Greeter().Greet(name);
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
  </PropertyGroup>` + "$reference" + `
</Project>`)
        }

        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2541", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
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

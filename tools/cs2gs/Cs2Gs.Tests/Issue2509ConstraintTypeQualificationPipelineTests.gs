// <copyright file="Issue2509ConstraintTypeQualificationPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Default SDK-backed/gsc sink coverage for issue #2509's cross-project
/// constraint collision and a negative control proving constraint enforcement
/// remains active.
class Issue2509ConstraintTypeQualificationPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_CrossProjectConstraintCollision_TranslatesAndCompiles() {
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
        let consumer = result.Apps.Single((app AppResult) -> app.AppId == "test/Consumer")
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(consumer.AppId))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("func Add[T A.IPerson class init()]() T", emitted, StringComparison.Ordinal)
        Assert.Contains("func Test() Author -> Add[Author]()", emitted, StringComparison.Ordinal)
    }

    @Fact
    func ViaSdk_GenuinelyUnsatisfiedConstraint_StillReportsGs0152() {
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let workDir = NewDirectory("negative-control")
        let sourcePath = Path.Combine(workDir, "Negative.gs")
        File.WriteAllText(sourcePath, `package Negative

interface IContract {
}

class Wrong {
}

class Repro {
    shared {
        func Add[T IContract]() {
        }

        func Test() -> Add[Wrong]()
    }
}`)
        let result = SdkCompileRunner().Compile(
            workDir,
            "Negative",
            []string{sourcePath},
            TargetKind.Library,
            Array.Empty[string](),
            Array.Empty[string](),
            Array.Empty[string](),
            rootNamespace: nil,
            config: "Release"
        )
        Assert.True(result.IsAvailable, result.UnavailableReason)
        Assert.False(result.Succeeded)
        Assert.Contains(result.Errors, (diagnostic GscDiagnostic) -> diagnostic.Id == "GS0152")
    }

    shared {
        private func WriteFixture(sourceRoot string)(ContractsProject string, ConsumerProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let contractsDir = Path.Combine(sourceRoot, "Contracts")
            Directory.CreateDirectory(contractsDir)
            let contractsProject = Path.Combine(contractsDir, "Contracts.csproj")
            File.WriteAllText(contractsProject, ProjectFile(nil))
            File.WriteAllText(Path.Combine(contractsDir, "Contracts.cs"), `namespace A;

public interface IPerson { }

public sealed class Author : IPerson
{
}`)
            let consumerDir = Path.Combine(sourceRoot, "Consumer")
            Directory.CreateDirectory(consumerDir)
            let consumerProject = Path.Combine(consumerDir, "Consumer.csproj")
            File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"))
            File.WriteAllText(Path.Combine(consumerDir, "Repro.cs"), `using A;

namespace B
{
    public interface IPerson { }
}

namespace App
{
    public static class Repro
    {
        public static T Add<T>() where T : class, IPerson, new() => new T();
        public static B.IPerson GetOther() => null;
        public static Author Test() => Add<Author>();
    }
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
    <Nullable>disable</Nullable>
  </PropertyGroup>` + "$reference" + `
</Project>`)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2509", Guid.NewGuid().ToString("N"))
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

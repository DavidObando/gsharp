// <copyright file="Issue2516SliceCovariancePipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Default `--via-sdk`/gsc regression for issue #2516's exact stable
/// minimal two-project repro (a referenced `Probe` project declaring
/// `IPerson`/`Author`, and a `Consumer` project passing an
/// `Author[]` where `IEnumerable<IPerson>?` is expected) plus the
/// Oahu `product.Authors -> IEnumerable<IPerson>` shape (a nullable
/// covariant argument read off a property, mirroring
/// `BookLibrary.AddPersons(..., product.Authors, ...)`).
class Issue2516SliceCovariancePipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_StableMinimalRepro_TranslatesAndCompiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let (probeProject, consumerProject) = WriteStableMinimalReproFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync(
            []CorpusApp{
                CorpusApp("test/Probe", probeProject, TargetKind.Library),
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
        let runDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(consumer.AppId))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        // Compiler-level slice/interface covariance makes the natural
        // translation valid; cs2gs must not manufacture an `as` escape hatch.
        Assert.Contains("Accept(values)", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("values as IEnumerable[IPerson]", emitted, StringComparison.Ordinal)
    }

    @Fact
    async func Pipeline_ViaSdkDefault_OahuAuthorsShape_TranslatesAndCompiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectPath = WriteOahuShapeFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/OahuShape", projectPath, TargetKind.Library)})
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(appResult.AppId))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("product.Authors", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("product.Authors as", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept the Oahu product.Authors -> IEnumerable<IPerson> shape. Stages: " +
                string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
    }

    @Fact
    async func Pipeline_ViaSdkDefault_CompilerCovarianceCoversFormerSinkWorkarounds() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectPath = WriteCompilerCovarianceSinkFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync(
            []CorpusApp{CorpusApp("test/CompilerCovarianceSinks", projectPath, TargetKind.Library)}
        )
        let appResult = Assert.Single(result.Apps)
        Assert.True(
            appResult.Succeeded,
            "Expected compiler covariance to cover folded static initialization, constructor lifting, " +
                "typed foreach, and expression-tree result conversion. Stages: " +
                string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(appResult.AppId))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.DoesNotContain(" as IEnumerable[IPerson]", emitted, StringComparison.Ordinal)
    }

    shared {
        private func WriteStableMinimalReproFixture(sourceRoot string)(ProbeProject string, ConsumerProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let probeDirectory = Path.Combine(sourceRoot, "Probe")
            Directory.CreateDirectory(probeDirectory)
            let probeProject = Path.Combine(probeDirectory, "Probe.csproj")
            File.WriteAllText(probeProject, ProjectFile(nil, nullable: true))
            File.WriteAllText(Path.Combine(probeDirectory, "Probe.cs"), `namespace Probe;
public interface IPerson { }
public sealed class Author : IPerson { }`)
            let consumerDirectory = Path.Combine(sourceRoot, "Consumer")
            Directory.CreateDirectory(consumerDirectory)
            let consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj")
            File.WriteAllText(consumerProject, ProjectFile("../Probe/Probe.csproj", nullable: true))
            File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), `using System.Collections.Generic;
using Probe;

namespace Consumer;

public static class Repro
{
    public static void Accept(IEnumerable<IPerson>? values) { }
    public static void Test(Author[] values) => Accept(values);
}`)
            return (probeProject, consumerProject)
        }

        private func WriteOahuShapeFixture(sourceRoot string) string {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let projectDir = Path.Combine(sourceRoot, "OahuShape")
            Directory.CreateDirectory(projectDir)
            let projectPath = Path.Combine(projectDir, "OahuShape.csproj")
            File.WriteAllText(projectPath, ProjectFile(nil, nullable: false))
            File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), `using System.Collections.Generic;

namespace OahuShape.Json
{
    public interface IPerson { }

    public sealed class Author : IPerson
    {
    }
}

namespace OahuShape.Models
{
    using OahuShape.Json;

    public sealed class Product
    {
        public Author[] Authors { get; set; } = new Author[0];
    }
}

namespace OahuShape
{
    using OahuShape.Json;
    using OahuShape.Models;

    public static class BookLibrary
    {
        private static void AddPersons<TPerson>(
            string label,
            IEnumerable<IPerson> itmPersons,
            int depth)
        {
        }

        public static void AddAuthors(Product product)
        {
            AddPersons<Author>("authors", product.Authors, 0);
        }
    }
}`)
            return projectPath
        }

        private func WriteCompilerCovarianceSinkFixture(sourceRoot string) string {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let projectDir = Path.Combine(sourceRoot, "CompilerCovarianceSinks")
            Directory.CreateDirectory(projectDir)
            let projectPath = Path.Combine(projectDir, "CompilerCovarianceSinks.csproj")
            File.WriteAllText(projectPath, ProjectFile(nil, nullable: false))
            File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), `using System;
using System.Collections.Generic;
using System.Linq.Expressions;

namespace CompilerCovarianceSinks;

public interface IPerson { }
public sealed class Author : IPerson { }

public sealed class Holder
{
    public readonly IEnumerable<IPerson> People;

    public Holder(Author[] people)
    {
        People = people;
    }
}

public static class Repro
{
    public static readonly IEnumerable<IPerson> StaticPeople;

    static Repro()
    {
        StaticPeople = new Author[0];
    }

    public static void Accept(IEnumerable<IPerson> people) { }

    public static Holder Create(Author[] people) => new Holder(people);

    public static void Visit(IEnumerable<Author[]> groups)
    {
        foreach (IEnumerable<IPerson> group in groups)
        {
            Accept(group);
        }
    }

    public static Expression<Func<Author[], IEnumerable<IPerson>>> Tree() =>
        people => people;
}`)
            return projectPath
        }

        private func ProjectFile(projectReference string?, nullable bool) string {
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
    <Nullable>` + "${(if nullable { "enable" } else { "disable" })}" + `</Nullable>
  </PropertyGroup>` + "$reference" + `
</Project>`)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2516", Guid.NewGuid().ToString("N"))
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

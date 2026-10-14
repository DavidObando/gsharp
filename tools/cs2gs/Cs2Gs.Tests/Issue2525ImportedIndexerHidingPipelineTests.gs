// <copyright file="Issue2525ImportedIndexerHidingPipelineTests.cs" company="GSharp">
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

/// Default `--via-sdk` coverage for imported interface indexer hiding,
/// including the ASP.NET Core `IHeaderDictionary` shape from issue #2525.
class Issue2525ImportedIndexerHidingPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_DerivedAndHeaderIndexers_Compile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let fixture = WriteFixture(sourceRoot)
        RunDotnetBuild(fixture.ConsumerProject)
        let outputRoot = NewDirectory("pipeline-tests")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync(
            []CorpusApp{
                CorpusApp("test/Contracts", fixture.ContractsProject, TargetKind.Library),
                CorpusApp("test/Consumer", fixture.ConsumerProject, TargetKind.Library)
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
        Assert.Contains("value[\"key\"]", emitted, StringComparison.Ordinal)
        Assert.Contains("value[key] = replacement", emitted, StringComparison.Ordinal)
        Assert.Contains("func ReadConstrained[T IDerived]", emitted, StringComparison.Ordinal)
        Assert.Contains("value[\"key\"] += \"!\"", emitted, StringComparison.Ordinal)
        Assert.Contains("value?[\"key\"]", emitted, StringComparison.Ordinal)
        Assert.Contains("Values: {[\"key\"] = \"nested\"}", Compact(emitted), StringComparison.Ordinal)
        Assert.Contains("ctx.Request.Headers[\"Authorization\"]", emitted, StringComparison.Ordinal)
        Assert.Contains("ctx.Response.Headers[\"Retry-After\"] = \"1\"", emitted, StringComparison.Ordinal)
    }

    private data class Fixture(ContractsProject string, ConsumerProject string) : IEquatable[
        Issue2525ImportedIndexerHidingPipelineTests.Fixture
    ] { }

    shared {
        private func WriteFixture(sourceRoot string) Issue2525ImportedIndexerHidingPipelineTests.Fixture {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let contractsDirectory = Path.Combine(sourceRoot, "Contracts")
            Directory.CreateDirectory(contractsDirectory)
            let contractsProject = Path.Combine(contractsDirectory, "Contracts.csproj")
            File.WriteAllText(contractsProject, ProjectFile())
            File.WriteAllText(Path.Combine(contractsDirectory, "Contracts.cs"), `namespace Issue2525.Contracts;

public interface IBase
{
    string this[string key] { get; set; }
}

public interface IDerived : IBase
{
    new string this[string key] { get; set; }
}

public interface IGenericBase<T>
{
    T this[T key] { get; set; }
}

public interface IGenericDerived<T> : IGenericBase<T>
{
    new T this[T key] { get; set; }
}

public interface IDiamondRoot
{
    string this[string key] { get; set; }
}

public interface IDiamondLeft : IDiamondRoot
{
    new string this[string key] { get; set; }
}

public interface IDiamondRight : IDiamondRoot
{
}

public interface IDiamondLeaf : IDiamondLeft, IDiamondRight
{
    new string this[string key] { get; set; }
}`)
            let consumerDirectory = Path.Combine(sourceRoot, "Consumer")
            Directory.CreateDirectory(consumerDirectory)
            let consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj")
            File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj", includeAspNetCore: true))
            File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), `using Issue2525.Contracts;
using Microsoft.AspNetCore.Http;

namespace Issue2525.Consumer;

public sealed class Holder
{
    public IDerived Values { get; } = CreateValues();

    private static IDerived CreateValues() =>
        throw new System.InvalidOperationException();
}

public static class Repro
{
    public static string Read(IDerived value) => value["key"];

    public static void Write(IDerived value, string key, string replacement) =>
        value[key] = replacement;

    public static string ReadBase(IDerived value) => ((IBase)value)["key"];

    public static T ReadGeneric<T>(IGenericDerived<T> value, T key) => value[key];

    public static string ReadConstrained<T>(T value)
        where T : IDerived =>
        value["key"];

    public static string ReadDiamond(IDiamondLeaf value) => value["key"];

    public static string Compound(IDerived value)
    {
        value["key"] += "!";
        return value["key"];
    }

    public static string? Conditional(IDerived? value) => value?["key"];

    public static Holder NestedInitializer() =>
        new Holder { Values = { ["key"] = "nested" } };

    public static string HeaderRead(HttpContext ctx) =>
        ctx.Request.Headers["Authorization"].ToString();

    public static void HeaderWrite(HttpContext ctx) =>
        ctx.Response.Headers["Retry-After"] = "1";
}`)
            return Issue2525ImportedIndexerHidingPipelineTests.Fixture(contractsProject, consumerProject)
        }

        private func ProjectFile(projectReference string? = nil, includeAspNetCore bool = false) string {
            let references = if projectReference == nil {
                string.Empty
            } else {
                (`
  <ItemGroup>
    <ProjectReference Include="` + "$projectReference" + `" />
  </ItemGroup>`)
            }
            let framework = if includeAspNetCore {
                `
  <ItemGroup>
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>`
            } else {
                string.Empty
            }
            return (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>` + "$references" + "$framework" + `
</Project>`)
        }

        private func RunDotnetBuild(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(projectPath)!!
            }
            startInfo.ArgumentList.Add("build")
            startInfo.ArgumentList.Add(projectPath)
            startInfo.ArgumentList.Add("--nologo")
            startInfo.ArgumentList.Add("--verbosity:quiet")
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet build.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(120_000), "dotnet build timed out.")
            Assert.True(process.ExitCode == 0, (`dotnet build failed (` + "${process.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
        }

        private func Compact(value string) string -> string.Join(
            " ",
            value.Split(default([]char), StringSplitOptions.RemoveEmptyEntries)
        )

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2525", Guid.NewGuid().ToString("N"))
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

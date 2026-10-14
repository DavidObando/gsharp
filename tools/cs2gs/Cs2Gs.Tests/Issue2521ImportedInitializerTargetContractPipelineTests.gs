// <copyright file="Issue2521ImportedInitializerTargetContractPipelineTests.cs" company="GSharp">
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

/// Default `--via-sdk`/gsc coverage for issue #2521 across a prebuilt,
/// multi-level project-reference graph.
class Issue2521ImportedInitializerTargetContractPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_ImportedInitializerSinks_CompileDeterministically() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let fixture = WriteFixture(sourceRoot)
        // Prebuild the middle project so both it and the leaf target assembly
        // exist on disk before MSBuildWorkspace loads the consumer.
        RunDotnetBuild(fixture.BridgeProject)
        let outputRoot = NewDirectory("pipeline-tests")
        let first = await RunPipeline(outputRoot, sourceRoot, compiler, fixture)
        let firstConsumer = AssertSuccessfulAndRead(first, outputRoot, "test/Consumer", "Consumer.cs")
        let firstEnabled = AssertSuccessfulAndRead(first, outputRoot, "test/EnabledConsumer", "EnabledConsumer.cs")
        AssertExpectedSinks(firstConsumer, firstEnabled)
        let second = await RunPipeline(outputRoot, sourceRoot, compiler, fixture)
        let secondConsumer = AssertSuccessfulAndRead(second, outputRoot, "test/Consumer", "Consumer.cs")
        let secondEnabled = AssertSuccessfulAndRead(second, outputRoot, "test/EnabledConsumer", "EnabledConsumer.cs")
        Assert.Equal(Compact(firstConsumer), Compact(secondConsumer))
        Assert.Equal(Compact(firstEnabled), Compact(secondEnabled))
        AssertExpectedSinks(secondConsumer, secondEnabled)
    }

    private data class Fixture(
        TargetProject string,
        BridgeProject string,
        ConsumerProject string,
        EnabledConsumerProject string
    ) : IEquatable[Issue2521ImportedInitializerTargetContractPipelineTests.Fixture] { }

    shared {
        private async func RunPipeline(
            outputRoot string,
            sourceRoot string,
            compiler string?,
            fixture Issue2521ImportedInitializerTargetContractPipelineTests.Fixture
        ) RunResult {
            let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
            Assert.True(options.CompileViaSdk)
            let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
            return await pipeline.RunAsync(
                []CorpusApp{
                    CorpusApp("test/Target", fixture.TargetProject, TargetKind.Library),
                    CorpusApp("test/Bridge", fixture.BridgeProject, TargetKind.Library),
                    CorpusApp("test/Consumer", fixture.ConsumerProject, TargetKind.Library),
                    CorpusApp("test/EnabledConsumer", fixture.EnabledConsumerProject, TargetKind.Library)
                }
            )
        }

        private func AssertExpectedSinks(consumer string, enabledConsumer string) {
            let compact = Compact(consumer)
            Assert.Contains(
                "Target{ Value: source.Value!!, InitValue: source.Value!!, Field: source.Value!! }",
                compact
            )
            Assert.Contains("Target(1){Value = source.Value!!}", compact)
            Assert.Contains("Nested: Target{Value: source.Value!!}", compact)
            Assert.Contains("T{Value: source.Value!!}", compact)
            Assert.Contains("List[string]{source.Value!!}", compact)
            Assert.Contains("Holder{Values: {source.Value!!}}", compact)
            Assert.Contains("Holder(1){Values = {source.Value!!}}", compact)
            Assert.Contains("\"key\": source.Value!!", compact)
            Assert.Contains("[\"key\"] = source.Value!!", compact)
            // Issue #3501: `value` here is nil-guard-narrowed, so the emitted
            // forgiveness is provably redundant and the polish pass strips it.
            Assert.Contains("Target{Value: value}", compact)
            Assert.Contains("LocalTarget{Value: source.Value}", compact)
            Assert.DoesNotContain("LocalTarget{Value: source.Value!!}", compact)
            Assert.Contains("NullableTarget{Value: source.Value}", compact)
            Assert.DoesNotContain("NullableTarget{Value: source.Value!!}", compact)
            let enabledCompact = Compact(enabledConsumer)
            Assert.Contains("Target{Value: source.Value!!}", enabledCompact)
            Assert.Contains("NullableTarget{Value: source.Value}", enabledCompact)
        }

        private func WriteFixture(sourceRoot string) Issue2521ImportedInitializerTargetContractPipelineTests.Fixture {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let targetDir = Path.Combine(sourceRoot, "Target")
            let bridgeDir = Path.Combine(sourceRoot, "Bridge")
            let consumerDir = Path.Combine(sourceRoot, "Consumer")
            let enabledDir = Path.Combine(sourceRoot, "EnabledConsumer")
            Directory.CreateDirectory(targetDir)
            Directory.CreateDirectory(bridgeDir)
            Directory.CreateDirectory(consumerDir)
            Directory.CreateDirectory(enabledDir)
            let targetProject = Path.Combine(targetDir, "Target.csproj")
            File.WriteAllText(targetProject, ProjectFile(nullable: "disable"))
            File.WriteAllText(Path.Combine(targetDir, "Target.cs"), `#nullable disable
namespace Imported;

public interface ITarget
{
    string Value { get; set; }
}

public sealed class Target : ITarget
{
    public Target() { }

    public Target(int id) { }

    public string Value { get; set; }

    public string InitValue { get; init; }

    public string Field;
}

public sealed class Holder
{
    public Holder() { }

    public Holder(int id) { }

    public System.Collections.Generic.List<string> Values { get; } = new();
}

#nullable enable
public sealed class NullableTarget
{
    public string? Value { get; set; }
}`)
            let bridgeProject = Path.Combine(bridgeDir, "Bridge.csproj")
            File.WriteAllText(bridgeProject, ProjectFile(nullable: "disable", "../Target/Target.csproj"))
            File.WriteAllText(Path.Combine(bridgeDir, "Bridge.cs"), `using Imported;

namespace Bridge;

public sealed class TargetFactory
{
    public Target Create() => new Target();
}`)
            let consumerProject = Path.Combine(consumerDir, "Consumer.csproj")
            File.WriteAllText(
                consumerProject,
                ProjectFile(nullable: "disable", "../Bridge/Bridge.csproj", "../Target/Target.csproj")
            )
            File.WriteAllText(Path.Combine(consumerDir, "Consumer.cs"), `#nullable disable
using System.Collections.Generic;
using Imported;

namespace Consumer;

public interface ISource
{
    string Value { get; set; }
}

public sealed class Wrapper
{
    public Target Nested { get; set; }
}

public sealed class LocalTarget
{
    public string Value { get; set; }

    public bool HasValue => Value is not null;
}

public static class Repro
{
    public static bool SourceMayBeNull(ISource source) => source.Value is null;

    public static Target Property(ISource source) =>
        new Target
        {
            Value = source.Value,
            InitValue = source.Value,
            Field = source.Value,
        };

    public static Target ConstructorSuffix(ISource source) =>
        new Target(1) { Value = source.Value };

    public static Wrapper Nested(ISource source) =>
        new Wrapper { Nested = new Target { Value = source.Value } };

    public static T GenericConstraint<T>(ISource source)
        where T : class, ITarget, new() =>
        new T { Value = source.Value };

    public static List<string> BareAdd(ISource source) =>
        new List<string> { source.Value };

    public static Holder NestedCollection(ISource source) =>
        new Holder { Values = { source.Value } };

    public static Holder SuffixNestedCollection(ISource source) =>
        new Holder(1) { Values = { source.Value } };

    public static Dictionary<string, string> KeyedAdd(ISource source) =>
        new Dictionary<string, string> { { "key", source.Value } };

    public static Dictionary<string, string> Indexed(ISource source) =>
        new Dictionary<string, string> { ["key"] = source.Value };

    public static Target Parameter(string value)
    {
        if (value is null)
            value = "fallback";

        return new Target { Value = value };
    }

    public static Target Local(ISource source)
    {
        string value = source.Value;
        if (value is null)
            value = "fallback";

        return new Target { Value = value };
    }

    public static LocalTarget SameCompilationTarget(ISource source) =>
        new LocalTarget { Value = source.Value };

    public static NullableTarget ReferencedNullableTarget(ISource source) =>
        new NullableTarget { Value = source.Value };
}`)
            let enabledConsumerProject = Path.Combine(enabledDir, "EnabledConsumer.csproj")
            File.WriteAllText(
                enabledConsumerProject,
                ProjectFile(nullable: "enable", "../Bridge/Bridge.csproj", "../Target/Target.csproj")
            )
            File.WriteAllText(Path.Combine(enabledDir, "EnabledConsumer.cs"), `using Imported;

namespace EnabledConsumer;

public interface ISource
{
    string? Value { get; }
}

public static class Repro
{
    public static Target Create(ISource source) =>
        new Target { Value = source.Value! };

    public static NullableTarget CreateNullable(ISource source) =>
        new NullableTarget { Value = source.Value };
}`)
            return Issue2521ImportedInitializerTargetContractPipelineTests.Fixture(
                targetProject,
                bridgeProject,
                consumerProject,
                enabledConsumerProject
            )
        }

        private func ProjectFile(nullable string, projectReferences ...string) string {
            let itemGroup = if projectReferences.Length == 0 {
                string.Empty
            } else {
                (`  <ItemGroup>
  ` + "${string.Join(Environment.NewLine, projectReferences.Select((reference string) -> "  <ProjectReference Include=\"$reference\" />"))}" + `
  </ItemGroup>`)
            }
            return (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>` + "$nullable" + `</Nullable>
  </PropertyGroup>
  ` + "$itemGroup" + `
</Project>`)
        }

        private func AssertSuccessfulAndRead(
            result RunResult,
            outputRoot string,
            appId string,
            fileName string
        ) string {
            let app = result.Apps.Single((candidate AppResult) -> candidate.AppId == appId)
            Assert.True(
                app.Succeeded,
                "Expected default --via-sdk/gsc compilation to succeed for $appId. Stages: " + string.Join(
                    "; ",
                    app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                )
            )
            let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(appId))
            let matches = Directory.GetFiles(
                appDirectory,
                fileName.Replace(".cs", ".gs", StringComparison.Ordinal),
                SearchOption.AllDirectories
            )
            Assert.Single(matches)
            return File.ReadAllText(matches[0])
        }

        private func RunDotnetBuild(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet", "build \"$projectPath\" --nologo --verbosity:quiet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1"
            using let process Process? = Process.Start(startInfo)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.True(process!!.ExitCode == 0, "Failed to prebuild multi-level fixture:\n" + stdout + stderr)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2521", Guid.NewGuid().ToString("N"))
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

        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}

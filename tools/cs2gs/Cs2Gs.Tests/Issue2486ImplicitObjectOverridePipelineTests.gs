// <copyright file="Issue2486ImplicitObjectOverridePipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #2486: ordinary C# classes do not spell an `object` base, so the
/// default SDK-backed migration path must compile their preserved overrides
/// against gsc's implicit (cref:object) base.
class Issue2486ImplicitObjectOverridePipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_ImplicitObjectOverrides_TranslateAndCompile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectDir = Path.Combine(sourceRoot, "src", "Sample")
        Directory.CreateDirectory(projectDir)
        let projectPath = Path.Combine(projectDir, "Sample.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDir, "Program.cs"), `using System;

namespace Sample;

public sealed class Widget
{
    public override string ToString() => "widget";

    public override int GetHashCode() => 2486;

    public override bool Equals(object? value) => true;
}

public static class Program
{
    public static void Main()
    {
        object value = new Widget();
        Console.WriteLine(value.ToString());
        Console.WriteLine(value.GetHashCode());
        Console.WriteLine(value.Equals(new Widget()));
    }
}`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/ImplicitObject", projectPath, TargetKind.Exe)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("class Widget", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("class Widget : Object", emitted, StringComparison.Ordinal)
        Assert.Contains("override func ToString", emitted, StringComparison.Ordinal)
        Assert.Contains("override func GetHashCode", emitted, StringComparison.Ordinal)
        Assert.Contains("override func Equals", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected the default --via-sdk compile to accept implicit Object overrides. Stages: " + string.Join(
                "; ",
                appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status)
            )
        )
    }

    shared {
        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2486", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirName string, dllName string) string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, projectDirName, dllName)
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}

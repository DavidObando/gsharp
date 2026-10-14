// <copyright file="Issue2613StaticDelegateMemberPipelineTests.cs" company="GSharp">
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

class Issue2613StaticDelegateMemberPipelineTests {
    @Fact
    async func Pipeline_StaticDelegatePropertyAndField_RemainAssignableAndInvocable() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectPath = WriteFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2613", projectPath, TargetKind.Exe)})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            "Expected translated static delegates to compile. Stages: " + string.Join(
                "; ",
                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
        let runDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("var _property(int32) -> int32", emitted, StringComparison.Ordinal)
        Assert.Contains("prop Property(int32) -> int32", emitted, StringComparison.Ordinal)
        Assert.Contains("var Field(int32) -> int32", emitted, StringComparison.Ordinal)
        Assert.Contains("Factory.Property(2)", emitted, StringComparison.Ordinal)
        Assert.Contains("Factory.Field(2)", emitted, StringComparison.Ordinal)
        let assembly = Directory.GetFiles(
            Path.Combine(runDirectory, "bin"),
            "Issue2613.dll",
            SearchOption.AllDirectories
        )
            .Single(
            (path string) -> !path.Contains(
                Path.DirectorySeparatorChar + "ref" + Path.DirectorySeparatorChar,
                StringComparison.Ordinal
            )
        )
        let startInfo = ProcessStartInfo("dotnet", "\"" + assembly + "\""){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        using let process = Process.Start(startInfo)!!
        let output = process.StandardOutput.ReadToEnd()
        let error = process.StandardError.ReadToEnd()
        process.WaitForExit()
        Assert.True(process.ExitCode == 0, error)
        Assert.Equal("12${Environment.NewLine}6${Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine))
    }

    shared {
        private func WriteFixture(sourceRoot string) string {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let projectDirectory = Path.Combine(sourceRoot, "Issue2613")
            Directory.CreateDirectory(projectDirectory)
            let projectPath = Path.Combine(projectDirectory, "Issue2613.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), `using System;

public static class Factory
{
    public static Func<int, int> Property { get; set; } = value => value + 1;
    public static Func<int, int> Field = value => value + 2;
}

Factory.Property = value => value + 10;
Factory.Field = value => value * 3;
Console.WriteLine(Factory.Property(2));
Console.WriteLine(Factory.Field(2));`)
            return projectPath
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2613", Guid.NewGuid().ToString("N"))
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

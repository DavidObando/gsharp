// <copyright file="Issue2551TranslatedRecordProjectReferencePipelineTests.cs" company="GSharp">
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

/// Issue #2551: a record translated in one project must retain data-class
/// semantics when an independently translated consumer sees its reference
/// assembly through a project reference.
class Issue2551TranslatedRecordProjectReferencePipelineTests {
    @Fact
    async func Pipeline_TranslatedRecordProjectReference_WithCopy_Runs() {
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
        let pipeline = MigrationPipeline(
            options,
            []IMigrationStage{TranslateStage(), CompileStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync(
            []CorpusApp{
                CorpusApp("test/Models", fixture.ModelsProject, TargetKind.Library),
                CorpusApp("test/Consumer", fixture.ConsumerProject, TargetKind.Exe, stdoutGolden: fixture.StdoutGolden)
            }
        )
        Assert.All(
            result.Apps,
            (app AppResult) -> Assert.True(
                app.Succeeded,
                app.AppId + " should translate, compile, and run. Stages: " + string.Join(
                    "; ",
                    app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                )
            )
        )
        let runDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId("test/Models"))
        let producer = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("data class Settings", producer, StringComparison.Ordinal)
        Assert.Contains("prop Label string {", producer, StringComparison.Ordinal)
    }

    private data class Fixture(ModelsProject string, ConsumerProject string, StdoutGolden string) : IEquatable[
        Issue2551TranslatedRecordProjectReferencePipelineTests.Fixture
    ] { }

    shared {
        private func WriteFixture(sourceRoot string) Issue2551TranslatedRecordProjectReferencePipelineTests.Fixture {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let modelsDirectory = Path.Combine(sourceRoot, "Models")
            Directory.CreateDirectory(modelsDirectory)
            let modelsProject = Path.Combine(modelsDirectory, "Models.csproj")
            File.WriteAllText(modelsProject, ProjectFile())
            File.WriteAllText(Path.Combine(modelsDirectory, "Settings.cs"), `namespace Models;

public sealed record Settings
{
    public string Label { get; init; } = "ready";

    public int Retries { get; init; } = 3;

    public static Settings Default => new();

    public static Models.Settings Copy(Models.Settings value)
        => value with { Label = "producer" };
}`)
            let consumerDirectory = Path.Combine(sourceRoot, "Consumer")
            Directory.CreateDirectory(consumerDirectory)
            let consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj")
            File.WriteAllText(consumerProject, ProjectFile("../Models/Models.csproj", outputType: "Exe"))
            File.WriteAllText(Path.Combine(consumerDirectory, "Program.cs"), `using System;
var original = Models.Settings.Default;
var produced = Models.Settings.Copy(original);
var changed = Change(produced);
var copied = changed with { Label = "copied" };

Console.WriteLine(original.Label);
Console.WriteLine(original.Retries);
Console.WriteLine(produced.Label);
Console.WriteLine(produced.Retries);
Console.WriteLine(changed.Label);
Console.WriteLine(changed.Retries);
Console.WriteLine(copied.Label);
Console.WriteLine(copied.Retries);

static Models.Settings Change(Models.Settings value)
    => value with { Retries = 8 };`)
            let stdoutGolden = Path.Combine(sourceRoot, "baseline.stdout.golden")
            File.WriteAllText(stdoutGolden, `ready
3
producer
3
producer
8
copied
8
`)
            return Issue2551TranslatedRecordProjectReferencePipelineTests.Fixture(
                modelsProject,
                consumerProject,
                stdoutGolden
            )
        }

        private func ProjectFile(projectReference string? = nil, outputType string? = nil) string {
            let output = if outputType == nil {
                string.Empty
            } else {
                "<OutputType>$outputType</OutputType>"
            }
            let reference = if projectReference == nil {
                string.Empty
            } else {
                (`  <ItemGroup>
    <ProjectReference Include="` + "$projectReference" + `" />
  </ItemGroup>`)
            }
            return (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    ` + "$output" + `
  </PropertyGroup>
  ` + "$reference" + `
</Project>`)
        }

        private func RunDotnetBuild(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.ArgumentList.Add("build")
            startInfo.ArgumentList.Add(projectPath)
            startInfo.ArgumentList.Add("--nologo")
            startInfo.ArgumentList.Add("--verbosity:quiet")
            using let process Process? = Process.Start(startInfo)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.True(process!!.ExitCode == 0, "Fixture build failed:\n" + stdout + stderr)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2551", Guid.NewGuid().ToString("N"))
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

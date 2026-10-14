// <copyright file="Issue2537ConcurrentDictionaryPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit

class Issue2537ConcurrentDictionaryPipelineTests {
    @Fact
    async func Pipeline_ViaSdk_ConcurrentDictionaryOfNestedUserGeneric_DeconstructsAndRuns() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectPath = WriteFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2537", projectPath, TargetKind.Exe)})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            "Expected ConcurrentDictionary<Guid, Channel<JobUpdate>> deconstruction to compile via gsc. Stages: " +
                string.Join("; ", app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
        let runDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId))
        let assembly = Directory.GetFiles(
            Path.Combine(runDirectory, "bin"),
            "Issue2537.dll",
            SearchOption.AllDirectories
        )
            .Single(
            (path string) -> !path.Contains(
                Path.DirectorySeparatorChar + "ref" + Path.DirectorySeparatorChar,
                StringComparison.Ordinal
            )
        )
        let (exitCode, output) = RunDotnet("\"$assembly\"")
        Assert.Equal(0, exitCode)
        Assert.Equal("0" + Environment.NewLine, output)
    }

    shared {
        private func WriteFixture(sourceRoot string) string {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let projectDir = Path.Combine(sourceRoot, "Issue2537")
            Directory.CreateDirectory(projectDir)
            let projectPath = Path.Combine(projectDir, "Issue2537.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(projectDir, "JobUpdate.cs"), `namespace Oahu.Cli.App.Models;

public sealed record JobUpdate
{
    public required string JobId { get; init; }
}`)
            File.WriteAllText(Path.Combine(projectDir, "JobScheduler.cs"), `using System;
using System.Collections.Concurrent;
using System.Threading.Channels;
using Oahu.Cli.App.Models;

namespace Oahu.Cli.App.Jobs;

public sealed class JobScheduler
{
    private readonly ConcurrentDictionary<Guid, Channel<JobUpdate>> subscribers = new();

    public void Run()
    {
        subscribers.TryAdd(Guid.Empty, Channel.CreateUnbounded<JobUpdate>());
        foreach (var (key, ch) in subscribers)
        {
            Console.WriteLine(ch.Reader.Count);
        }
    }
}`)
            File.WriteAllText(Path.Combine(projectDir, "Program.cs"), `using Oahu.Cli.App.Jobs;

new JobScheduler().Run();`)
            return projectPath
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2537", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func RunDotnet(arguments string)(ExitCode int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
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

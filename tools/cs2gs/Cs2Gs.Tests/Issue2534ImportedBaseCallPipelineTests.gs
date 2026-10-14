// <copyright file="Issue2534ImportedBaseCallPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Project-backed compile and runtime coverage for imported base virtual calls.
class Issue2534ImportedBaseCallPipelineTests {
    @Fact
    async func Pipeline_ImportedFrameworkBaseCall_EmitsCanonicalSyntaxAndRuns() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectDirectory = Path.Combine(sourceRoot, "ImportedBaseCall")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "ImportedBaseCall.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), `using System;
using System.IO;

namespace ImportedBaseCall;

public sealed class RecordingStream : MemoryStream
{
    public int Calls { get; private set; }

    public override void Write(byte[] buffer, int offset, int count)
    {
        Calls++;
        base.Write(buffer, offset, count);
    }
}

public static class Program
{
    public static void Main()
    {
        var stream = new RecordingStream();
        stream.Write(new byte[] { 1, 2, 3 }, 0, 3);
        Console.WriteLine(stream.Calls);
        Console.WriteLine(stream.Length);
        Console.WriteLine(stream.ToArray()[1]);
    }
}`)
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(goldenPath, `1
3
2
`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/ImportedBaseCall", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(
            options,
            []IMigrationStage{TranslateStage(), CompileStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let runDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("base.Write(buffer, offset, count)", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("base!!", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected imported base call to compile and preserve runtime behavior. Stages: " + string.Join(
                "; ",
                appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
    }

    shared {
        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2534", Guid.NewGuid().ToString("N"))
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

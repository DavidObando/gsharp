// <copyright file="Issue2540ImportedGenericCoalescePipelineTests.cs" company="GSharp">
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

class Issue2540ImportedGenericCoalescePipelineTests {
    @Fact
    async func Pipeline_ImportedGenericLoggerCoalesce_Compiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDir = Path.Combine(sourceRoot, "Issue2540")
        Directory.CreateDirectory(projectDir)
        let projectPath = Path.Combine(projectDir, "Issue2540.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="10.0.5" />
  </ItemGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDir, "Service.cs"), `using System.Collections.ObjectModel;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Issue2540;

public sealed class Service
{
    private readonly ILogger<Service> logger;

    public Service(ILogger<Service>? logger = null)
    {
        this.logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<Service>.Instance;
    }
}

public sealed class Book { }

public static class Selection
{
    public static Book Pick(Book? sel, ObservableCollection<Book> Books)
        => sel ?? Books[0];
}`)
        RunDotnetBuild(projectPath)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2540", projectPath, TargetKind.Library)})
        let app = Assert.Single(result.Apps)
        let emitted = ReadAppOutput(outputRoot, result.RunId, app.AppId)
        Assert.Contains("logger ?? NullLogger[Service].Instance", emitted, StringComparison.Ordinal)
        Assert.Contains("sel ?? Books[0]", emitted, StringComparison.Ordinal)
        Assert.True(
            app.Succeeded,
            "Expected imported generic logger coalescing to compile via gsc. Stages: " + string.Join(
                "; ",
                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
    }

    shared {
        private func ReadAppOutput(outputRoot string, runId string, appId string) string {
            let directory = Path.Combine(outputRoot, runId, MigrationPipeline.SanitizeAppId(appId))
            return string.Join(
                Environment.NewLine,
                Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
            )
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2540", Guid.NewGuid().ToString("N"))
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

        private func RunDotnetBuild(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet", "build \"$projectPath\" --nologo --verbosity:quiet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1"
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to build issue #2540 fixture.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            process.WaitForExit()
            Assert.True(process.ExitCode == 0, "Fixture build failed:\n" + stdout + stderr)
        }
    }
}

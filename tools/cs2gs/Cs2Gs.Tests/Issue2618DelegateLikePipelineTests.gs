// <copyright file="Issue2618DelegateLikePipelineTests.cs" company="GSharp">
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

@Collection("Issue2599NuGetEnvironment")
class Issue2618DelegateLikePipelineTests : IDisposable {
    private let previousNuGetPackages string?

    init() {
        this.previousNuGetPackages = Environment.GetEnvironmentVariable("NUGET_PACKAGES")
        Environment.SetEnvironmentVariable("NUGET_PACKAGES", NewDirectory("sdk-packages"))
    }

    @Fact
    async func Pipeline_RelayCommandAndActionLikeConstructor_Compile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("source")
        let projectPath = WriteProject(sourceRoot)
        AssertProcessSucceeds("dotnet", "restore \"$projectPath\" --nologo", sourceRoot)
        let outputRoot = NewDirectory("output")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2618", projectPath, TargetKind.Library)})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            string.Join(
                Environment.NewLine,
                app.Artifacts.Select((path string) -> File.ReadAllText(Path.Combine(outputRoot, result.RunId, path)))
            )
        )
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId))
        let translated = File.ReadAllText(Path.Combine(appDirectory, "Repro.gs"))
        Assert.Contains("let onState(State) -> void", translated, StringComparison.Ordinal)
        Assert.Contains("Job(onState)", translated, StringComparison.Ordinal)
        let generated = File.ReadAllText(
            Directory.GetFiles(Path.Combine(appDirectory, "obj"), "*Vm.Run.g.gs", SearchOption.AllDirectories).Single()
        )
        Assert.Contains("AsyncRelayCommand(Run)", generated, StringComparison.Ordinal)
        Assert.DoesNotContain("= RelayCommand(Run)", generated, StringComparison.Ordinal)
    }

    func Dispose() {
        Environment.SetEnvironmentVariable("NUGET_PACKAGES", this.previousNuGetPackages)
    }

    shared {
        private func WriteProject(sourceRoot string) string {
            let projectPath = Path.Combine(sourceRoot, "Issue2618.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.0" />
  </ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(sourceRoot, "Repro.cs"), `using System;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace Issue2618;

public sealed class State
{
    public int Value { get; set; }
}

public sealed class Job
{
    public Job(Action<State> callback) => callback(new State());
}

public partial class Vm : ObservableObject
{
    [RelayCommand]
    private async Task Run() => await Task.Yield();

    public void Wire()
    {
        Action<State> onState = state => _ = state.Value;
        _ = new Job(onState);
    }
}`)
            return projectPath
        }

        private func AssertProcessSucceeds(fileName string, arguments string, workingDirectory string) {
            using let process Process? = Process.Start(
                ProcessStartInfo{
                    FileName: fileName,
                    Arguments: arguments,
                    WorkingDirectory: workingDirectory,
                    RedirectStandardOutput: true,
                    RedirectStandardError: true,
                    UseShellExecute: false
                }
            )
            let output = process!!.StandardOutput.ReadToEnd() + process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.True(process!!.ExitCode == 0, output)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "issue2618", category, Guid.NewGuid().ToString("N"))
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

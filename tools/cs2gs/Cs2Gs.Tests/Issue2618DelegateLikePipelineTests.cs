// <copyright file="Issue2618DelegateLikePipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

[Collection("Issue2599NuGetEnvironment")]
public sealed class Issue2618DelegateLikePipelineTests : IDisposable
{
    private readonly string previousNuGetPackages;

    public Issue2618DelegateLikePipelineTests()
    {
        this.previousNuGetPackages = Environment.GetEnvironmentVariable("NUGET_PACKAGES");
        Environment.SetEnvironmentVariable("NUGET_PACKAGES", NewDirectory("sdk-packages"));
    }

    [Fact]
    public async Task Pipeline_RelayCommandAndActionLikeConstructor_Compile()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("source");
        string projectPath = WriteProject(sourceRoot);
        AssertProcessSucceeds("dotnet", $"restore \"{projectPath}\" --nologo", sourceRoot);

        string outputRoot = NewDirectory("output");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/Issue2618", projectPath, TargetKind.Library),
        });
        AppResult app = Assert.Single(result.Apps);
        Assert.True(
            app.Succeeded,
            string.Join(
                Environment.NewLine,
                app.Artifacts.Select(path => File.ReadAllText(Path.Combine(
                    outputRoot,
                    result.RunId,
                    path)))));

        string appDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.AppId));
        string translated = File.ReadAllText(Path.Combine(appDirectory, "Repro.gs"));
        Assert.Contains("let onState (State) -> void", translated, StringComparison.Ordinal);
        Assert.Contains("Job(onState)", translated, StringComparison.Ordinal);

        string generated = File.ReadAllText(Directory.GetFiles(
            Path.Combine(appDirectory, "obj"),
            "*Vm.Run.g.gs",
            SearchOption.AllDirectories).Single());
        Assert.Contains("AsyncRelayCommand(Run)", generated, StringComparison.Ordinal);
        Assert.DoesNotContain("= RelayCommand(Run)", generated, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("NUGET_PACKAGES", this.previousNuGetPackages);
    }

    private static string WriteProject(string sourceRoot)
    {
        string projectPath = Path.Combine(sourceRoot, "Issue2618.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.0" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(sourceRoot, "Repro.cs"), """
            using System;
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
            }
            """);
        return projectPath;
    }

    private static void AssertProcessSucceeds(string fileName, string arguments, string workingDirectory)
    {
        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, output);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            "issue2618",
            category,
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirectoryName, string dllName)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    projectDirectoryName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}

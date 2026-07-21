// <copyright file="Issue2585SemanticQualificationPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2585SemanticQualificationPipelineTests
{
    [Fact]
    public async Task Pipeline_NestedNamespacesAndEventLambda_PreserveSemanticRootsAndCompile()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        (string appProject, string tuiProject) = WriteFixture(sourceRoot);
        string outputRoot = NewDirectory("pipeline-tests");
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
            new CorpusApp("test/App", appProject, TargetKind.Library),
            new CorpusApp("test/Tui", tuiProject, TargetKind.Library),
        });

        Assert.All(
            result.Apps,
            app => Assert.True(
                app.Succeeded,
                app.AppId + " should compile. Stages: " +
                    string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status))));

        string appOutput = ReadOutput(outputRoot, result.RunId, "test/App");
        Assert.Contains("package Oahu.App", appOutput, StringComparison.Ordinal);
        Assert.Contains("package Oahu.Tui", appOutput, StringComparison.Ordinal);
        Assert.Contains("package Oahu.Tui.Nested", appOutput, StringComparison.Ordinal);

        string tuiOutput = ReadOutput(outputRoot, result.RunId, "test/Tui");
        Assert.Contains("package Oahu.Tui", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("import AppTypes = Oahu.App", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("vm.Changed += () ->", tuiOutput, StringComparison.Ordinal);
    }

    private static (string AppProject, string TuiProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string appDirectory = Path.Combine(sourceRoot, "App");
        Directory.CreateDirectory(appDirectory);
        string appProject = Path.Combine(appDirectory, "App.csproj");
        File.WriteAllText(appProject, ProjectFile(null));
        File.WriteAllText(Path.Combine(appDirectory, "ViewModel.cs"), """
            using System;

            namespace Oahu
            {
                namespace App
                {
                    public sealed class ViewModel
                    {
                        public event Action Changed;
                        public void Refresh() { }
                    }

                    public sealed class Hub
                    {
                        public event Action<ViewModel> Changed;
                    }
                }
            }
            """);
        File.WriteAllText(Path.Combine(appDirectory, "QualificationTrap.cs"), """
            namespace Oahu
            {
                namespace Tui
                {
                    public sealed class vm
                    {
                    }
                }
            }
            """);
        File.WriteAllText(Path.Combine(appDirectory, "NestedTrap.cs"), """
            namespace Oahu
            {
                namespace Tui
                {
                    namespace Nested
                    {
                        public sealed class Refresh
                        {
                            public Refresh() { }
                        }
                    }
                }
            }
            """);

        string tuiDirectory = Path.Combine(sourceRoot, "Tui");
        Directory.CreateDirectory(tuiDirectory);
        string tuiProject = Path.Combine(tuiDirectory, "Tui.csproj");
        File.WriteAllText(tuiProject, ProjectFile("../App/App.csproj"));
        File.WriteAllText(Path.Combine(tuiDirectory, "Wiring.cs"), """
            using AppTypes = Oahu.App;
            using Oahu.Tui;

            namespace Oahu
            {
                namespace Tui
                {
                    public static class Wiring
                    {
                        public static void Connect(AppTypes.Hub hub)
                        {
                            hub.Changed += vm =>
                            {
                                vm.Changed += () => { };
                                vm.Refresh();
                            };
                        }
                    }
                }
            }
            """);

        return (appProject, tuiProject);
    }

    private static string ProjectFile(string projectReference)
    {
        string reference = projectReference is null
            ? string.Empty
            : $"""

                <ItemGroup>
                  <ProjectReference Include="{projectReference}" />
                </ItemGroup>
              """;
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>{reference}
            </Project>
            """;
    }

    private static string ReadOutput(string outputRoot, string runId, string appId)
    {
        string directory = Path.Combine(
            outputRoot,
            runId,
            MigrationPipeline.SanitizeAppId(appId));
        return string.Join(
            Environment.NewLine,
            Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2585",
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

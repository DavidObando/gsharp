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
    public async Task Pipeline_OahuCoreQualifiedJsonOptions_WithTypeHomonymCompiles()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("oahu-core-projects");
        string coreProject = WriteOahuCoreFixture(sourceRoot);
        string outputRoot = NewDirectory("oahu-core-pipeline");
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
            new CorpusApp("corpus/Oahu.Core", coreProject, TargetKind.Library),
        });

        var app = Assert.Single(result.Apps);
        Assert.True(
            app.Succeeded,
            app.AppId + " should compile. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));

        string output = ReadOutput(outputRoot, result.RunId, "corpus/Oahu.Core");
        Assert.Contains(
            "Oahu.Aux.Extensions.JsonExtensions.Options",
            output,
            StringComparison.Ordinal);
    }

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
        Assert.Contains("import Oahu.Cli.App.Core", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("import Oahu.Cli.Commands", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("import Oahu.Cli.Tui.Icons", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("import Oahu.Cli.Tui.Widgets", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("import Spectre.Console", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("import System", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("CoreEnvironment.Initialize()", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("TuiCommand.Reset()", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("Rule.Default", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("SelectList[string]", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("Icons.Success", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("DateTime.UtcNow", tuiOutput, StringComparison.Ordinal);
        Assert.Contains("let vm ViewModel? = value as ViewModel", tuiOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("App.Core.CoreEnvironment", tuiOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("Commands.TuiCommand", tuiOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("Spectre.Console.Rule", tuiOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("Tui.Icons.Icons", tuiOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("System.DateTime", tuiOutput, StringComparison.Ordinal);
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
        File.WriteAllText(Path.Combine(appDirectory, "Cycle4Types.cs"), """
            namespace Oahu.Cli.App.Core
            {
                public static class CoreEnvironment
                {
                    public static void Initialize() { }
                }
            }

            namespace Oahu.Cli.Commands
            {
                public static class TuiCommand
                {
                    public static void Reset() { }
                }
            }

            namespace Oahu.Cli.Tui.Icons
            {
                public static class Icons
                {
                    public static string Success => "ok";
                }
            }

            namespace Oahu.Cli.Tui.Widgets
            {
                public sealed class SelectList<T>
                {
                    public T Value { get; set; }
                }
            }

            namespace Spectre.Console
            {
                public sealed class Rule
                {
                    public static string Default => "rule";
                }
            }
            """);

        string tuiDirectory = Path.Combine(sourceRoot, "Tui");
        Directory.CreateDirectory(tuiDirectory);
        string tuiProject = Path.Combine(tuiDirectory, "Tui.csproj");
        File.WriteAllText(tuiProject, ProjectFile("../App/App.csproj"));
        File.WriteAllText(Path.Combine(tuiDirectory, "Wiring.cs"), """
            using AppTypes = Oahu.App;
            using Oahu.Cli.Tui.Widgets;
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
        File.WriteAllText(Path.Combine(tuiDirectory, "Cycle4.cs"), """
            using AppTypes = Oahu.App;
            using Oahu.Cli.Tui.Widgets;

            namespace Oahu.Cli;

            public static class Cycle4
            {
                public static void Run(object value, bool blocked)
                {
                    App.Core.CoreEnvironment.Initialize();
                    Commands.TuiCommand.Reset();
                    var rule = Spectre.Console.Rule.Default;
                    var list = new SelectList<string> { Value = "ok" };
                    var icon = Tui.Icons.Icons.Success;
                    var year = System.DateTime.UtcNow.Year;

                    if (value is not AppTypes.ViewModel vm || blocked)
                    {
                        return;
                    }

                    vm.Refresh();
                }
            }
            """);

        return (appProject, tuiProject);
    }

    private static string WriteOahuCoreFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string foundationDirectory = Path.Combine(sourceRoot, "Oahu.Foundation");
        Directory.CreateDirectory(foundationDirectory);
        string foundationProject = Path.Combine(foundationDirectory, "Oahu.Foundation.csproj");
        File.WriteAllText(foundationProject, ProjectFile(null));
        File.WriteAllText(Path.Combine(foundationDirectory, "JsonExtensions.cs"), """
            namespace Oahu.Aux.Extensions;

            public static class JsonExtensions
            {
                public static object Options => new();
            }
            """);

        string coreDirectory = Path.Combine(sourceRoot, "Oahu.Core");
        Directory.CreateDirectory(coreDirectory);
        string coreProject = Path.Combine(coreDirectory, "Oahu.Core.csproj");
        File.WriteAllText(coreProject, ProjectFile("../Oahu.Foundation/Oahu.Foundation.csproj"));
        File.WriteAllText(Path.Combine(coreDirectory, "ExtensionsVarious.cs"), """
            namespace Oahu.Core.Ex;

            public static class JsonExtensions
            {
                public static bool ValidateJson(string json) => json is not null;
            }
            """);
        File.WriteAllText(Path.Combine(coreDirectory, "Serialization.cs"), """
            using Oahu.Aux.Extensions;

            namespace Oahu.Audible.Json;

            public abstract class Serialization<T>
            {
                private static object Options { get; } = JsonExtensions.Options;
            }
            """);

        return coreProject;
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

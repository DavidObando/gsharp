// <copyright file="Issue2585SemanticQualificationPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue2585SemanticQualificationPipelineTests {
    @Fact
    func MultiNamespaceDocument_CanBeSplitByDeclaredPackage() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("AudioQuality.cs", `[assembly: System.Reflection.AssemblyTitleAttribute("Oahu")]

namespace Oahu.BooksDatabase
{
    namespace Ex
    {
        public static class ExCodec
        {
            public static bool Parse() => true;
        }
    }

    public record AudioQuality(int? SampleRate, int? BitRate);
}`)})
        let document = Assert.Single(project.Documents)
        let packages = CSharpToGSharpTranslator.GetDeclaredPackages(document).ToArray()
        Assert.Equal([]string{"Oahu.BooksDatabase.Ex", "Oahu.BooksDatabase"}, packages)
        let parent = GSharpPrinter.Print(
            CSharpToGSharpTranslator(
                packageFilter: "Oahu.BooksDatabase",
                includeFileAttributes: true
            ).TranslateDocument(document)
        )
        let nested = GSharpPrinter.Print(
            CSharpToGSharpTranslator(
                packageFilter: "Oahu.BooksDatabase.Ex",
                includeFileAttributes: false
            ).TranslateDocument(document)
        )
        Assert.Contains("package Oahu.BooksDatabase", parent)
        Assert.Contains("@assembly:System.Reflection.AssemblyTitleAttribute(\"Oahu\")", parent)
        Assert.Contains("data class AudioQuality", parent)
        Assert.DoesNotContain("ExCodec", parent)
        Assert.Contains("package Oahu.BooksDatabase.Ex", nested)
        Assert.DoesNotContain("@assembly:", nested)
        Assert.Contains("func Parse()", nested)
        Assert.DoesNotContain("AudioQuality", nested)
    }

    @Fact
    async func Pipeline_OahuCoreQualifiedJsonOptions_WithTypeHomonymCompiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("oahu-core-projects")
        let coreProject = WriteOahuCoreFixture(sourceRoot)
        let outputRoot = NewDirectory("oahu-core-pipeline")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync(
            []CorpusApp{CorpusApp("corpus/Oahu.Core", coreProject, TargetKind.Library)}
        )
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            app.AppId + " should compile. Stages: " + string.Join(
                "; ",
                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
        let output = ReadOutput(outputRoot, result.RunId, "corpus/Oahu.Core")
        Assert.Contains("Oahu.Aux.Extensions.JsonExtensions.Options", output, StringComparison.Ordinal)
    }

    @Fact
    async func Pipeline_NestedNamespacesAndEventLambda_PreserveSemanticRootsAndCompile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let (appProject, tuiProject) = WriteFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync(
            []CorpusApp{
                CorpusApp("test/App", appProject, TargetKind.Library),
                CorpusApp("test/Tui", tuiProject, TargetKind.Library)
            }
        )
        Assert.All(
            result.Apps,
            (app AppResult) -> Assert.True(
                app.Succeeded,
                app.AppId + " should compile. Stages: " + string.Join(
                    "; ",
                    app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                )
            )
        )
        let appOutput = ReadOutput(outputRoot, result.RunId, "test/App")
        Assert.Contains("package Oahu.App", appOutput, StringComparison.Ordinal)
        Assert.Contains("package Oahu.Tui", appOutput, StringComparison.Ordinal)
        Assert.Contains("package Oahu.Tui.Nested", appOutput, StringComparison.Ordinal)
        let tuiOutput = ReadOutput(outputRoot, result.RunId, "test/Tui")
        Assert.Contains("package Oahu.Tui", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("import AppTypes = Oahu.App", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("vm.Changed += () ->", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("import Oahu.Cli.App.Core", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("import Oahu.Cli.Commands", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("import Oahu.Cli.Tui.Icons", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("import Oahu.Cli.Tui.Widgets", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("import Spectre.Console", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("import System", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("CoreEnvironment.Initialize()", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("TuiCommand.Reset()", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("Rule.Default", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("SelectList[string]", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("Icons.Success", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("DateTime.UtcNow", tuiOutput, StringComparison.Ordinal)
        // ADR-0166 / issue #3409: the negated guard keeps its C# shape and name
        // (`value is not ViewModel vm`), with the semantic root still simplified.
        Assert.Contains("if value is not ViewModel vm || blocked {", tuiOutput, StringComparison.Ordinal)
        Assert.Contains("vm.Refresh()", tuiOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("App.Core.CoreEnvironment", tuiOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("Commands.TuiCommand", tuiOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("Spectre.Console.Rule", tuiOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("Tui.Icons.Icons", tuiOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("System.DateTime", tuiOutput, StringComparison.Ordinal)
    }

    shared {
        private func WriteFixture(sourceRoot string)(AppProject string, TuiProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let appDirectory = Path.Combine(sourceRoot, "App")
            Directory.CreateDirectory(appDirectory)
            let appProject = Path.Combine(appDirectory, "App.csproj")
            File.WriteAllText(appProject, ProjectFile(nil))
            File.WriteAllText(Path.Combine(appDirectory, "ViewModel.cs"), `using System;

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
}`)
            File.WriteAllText(Path.Combine(appDirectory, "QualificationTrap.cs"), `namespace Oahu
{
    namespace Tui
    {
        public sealed class vm
        {
        }
    }
}`)
            File.WriteAllText(Path.Combine(appDirectory, "NestedTrap.cs"), `namespace Oahu
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
}`)
            File.WriteAllText(Path.Combine(appDirectory, "Cycle4Types.cs"), `namespace Oahu.Cli.App.Core
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
}`)
            let tuiDirectory = Path.Combine(sourceRoot, "Tui")
            Directory.CreateDirectory(tuiDirectory)
            let tuiProject = Path.Combine(tuiDirectory, "Tui.csproj")
            File.WriteAllText(tuiProject, ProjectFile("../App/App.csproj"))
            File.WriteAllText(Path.Combine(tuiDirectory, "Wiring.cs"), `using AppTypes = Oahu.App;
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
}`)
            File.WriteAllText(Path.Combine(tuiDirectory, "Cycle4.cs"), `using AppTypes = Oahu.App;
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
}`)
            return (appProject, tuiProject)
        }

        private func WriteOahuCoreFixture(sourceRoot string) string {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let foundationDirectory = Path.Combine(sourceRoot, "Oahu.Foundation")
            Directory.CreateDirectory(foundationDirectory)
            let foundationProject = Path.Combine(foundationDirectory, "Oahu.Foundation.csproj")
            File.WriteAllText(foundationProject, ProjectFile(nil))
            File.WriteAllText(Path.Combine(foundationDirectory, "JsonExtensions.cs"), `namespace Oahu.Aux.Extensions;

public static class JsonExtensions
{
    public static object Options => new();
}`)
            let coreDirectory = Path.Combine(sourceRoot, "Oahu.Core")
            Directory.CreateDirectory(coreDirectory)
            let coreProject = Path.Combine(coreDirectory, "Oahu.Core.csproj")
            File.WriteAllText(coreProject, ProjectFile("../Oahu.Foundation/Oahu.Foundation.csproj"))
            File.WriteAllText(Path.Combine(coreDirectory, "ExtensionsVarious.cs"), `namespace Oahu.Core.Ex;

public static class JsonExtensions
{
    public static bool ValidateJson(string json) => json is not null;
}`)
            File.WriteAllText(Path.Combine(coreDirectory, "Serialization.cs"), `using Oahu.Aux.Extensions;

namespace Oahu.Audible.Json;

public abstract class Serialization<T>
{
    private static object Options { get; } = JsonExtensions.Options;
}`)
            return coreProject
        }

        private func ProjectFile(projectReference string?) string {
            let reference = if projectReference == nil {
                string.Empty
            } else {
                (`
  <ItemGroup>
    <ProjectReference Include="` + "$projectReference" + `" />
  </ItemGroup>`)
            }
            return (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>` + "$reference" + `
</Project>`)
        }

        private func ReadOutput(outputRoot string, runId string, appId string) string {
            let directory = Path.Combine(outputRoot, runId, MigrationPipeline.SanitizeAppId(appId))
            return string.Join(
                Environment.NewLine,
                Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
            )
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2585", Guid.NewGuid().ToString("N"))
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

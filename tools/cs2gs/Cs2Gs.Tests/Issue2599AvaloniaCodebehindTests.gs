// <copyright file="Issue2599AvaloniaCodebehindTests.cs" company="GSharp">
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

@CollectionDefinition("Issue2599NuGetEnvironment", DisableParallelization = true)
class Issue2599NuGetEnvironmentCollection { }

@Collection("Issue2599NuGetEnvironment")
class Issue2599AvaloniaCodebehindTests : IDisposable {
    private let previousNuGetPackages string?

    init() {
        this.previousNuGetPackages = Environment.GetEnvironmentVariable("NUGET_PACKAGES")
        Environment.SetEnvironmentVariable("NUGET_PACKAGES", NewDirectory("sdk-packages"))
    }

    @Fact
    async func Pipeline_AvaloniaGeneratedPartialAndCodebehind_CompileTogether() {
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
        let result = await pipeline.RunAsync(
            []CorpusApp{CorpusApp("test/AvaloniaCodebehind", projectPath, TargetKind.Library)}
        )
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            string.Join(
                Environment.NewLine,
                app.Artifacts.Select((path string) -> File.ReadAllText(Path.Combine(outputRoot, result.RunId, path)))
            )
        )
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId))
        let codebehind = File.ReadAllText(Path.Combine(appDirectory, "LibraryView.axaml.gs"))
        Assert.Contains("open partial class LibraryView : UserControl", codebehind, StringComparison.Ordinal)
        // ADR-0166 / issue #3409: the negated guard keeps its C# shape and name.
        Assert.Contains("if DataContext is not State vm || booksGrid == nil", codebehind, StringComparison.Ordinal)
        // Issue #4262 follow-up (item 2): `booksGrid` is a NON-readonly,
        // XAML-generated field, so it is not a stable access path — the
        // local-capture rewrite deliberately excludes it, leaving the
        // original per-use `!!` in place at this receiver use.
        Assert.Contains("vm.Count = booksGrid!!.Columns", codebehind, StringComparison.Ordinal)
        Assert.Contains("override async func OnLoaded", codebehind, StringComparison.Ordinal)
        Assert.Contains("RoutedEventArgs) void", codebehind, StringComparison.Ordinal)
        Assert.DoesNotContain("__asyncVoid_", codebehind, StringComparison.Ordinal)
        Assert.Contains("base.OnLoaded(e)", codebehind, StringComparison.Ordinal)
        let generated = File.ReadAllText(
            Directory.GetFiles(Path.Combine(appDirectory, "obj"), "*LibraryView*.g.gs", SearchOption.AllDirectories)
                .Single()
        )
        Assert.Contains("var booksGrid DataGrid?", generated, StringComparison.Ordinal)
        Assert.Contains("@System.CodeDom.Compiler.GeneratedCode", generated, StringComparison.Ordinal)
    }

    @Fact
    async func Pipeline_SecondaryPartialPropertyThroughAsCast_Compiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("issue2641-source")
        let projectPath = WriteIssue2641Project(sourceRoot)
        AssertProcessSucceeds("dotnet", "restore \"$projectPath\" --nologo", sourceRoot)
        let outputRoot = NewDirectory("issue2641-output")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2641", projectPath, TargetKind.Library)})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            string.Join(
                Environment.NewLine,
                app.Artifacts.Select((path string) -> File.ReadAllText(Path.Combine(outputRoot, result.RunId, path)))
            )
        )
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId))
        let view = File.ReadAllText(Path.Combine(appDirectory, "C.View.gs"))
        Assert.Contains(
            "(context as Selection)!!.Asin = (x as BookItemViewModel)!!.Asin",
            view,
            StringComparison.Ordinal
        )
        Assert.Contains("(context as Selection)!!.Item = (x as BookItemViewModel)!!", view, StringComparison.Ordinal)
    }

    func Dispose() {
        Environment.SetEnvironmentVariable("NUGET_PACKAGES", this.previousNuGetPackages)
    }

    shared {
        private func WriteProject(sourceRoot string) string {
            let packagesPath = Path.Combine(sourceRoot, "packages")
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), (`<Project>
  <PropertyGroup>
    <RestorePackagesPath>` + "$packagesPath" + `</RestorePackagesPath>
  </PropertyGroup>
</Project>`))
            let projectPath = Path.Combine(sourceRoot, "AvaloniaCodebehind.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <RootNamespace>Issue2599.Fixture</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Avalonia" Version="11.2.7" />
    <PackageReference Include="Avalonia.Controls.DataGrid" Version="11.2.7" />
  </ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(sourceRoot, "LibraryView.axaml"), `<UserControl
    x:Class="Issue2599.Fixture.LibraryView"
    xmlns="https://github.com/avaloniaui"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <DataGrid x:Name="booksGrid" />
</UserControl>`)
            File.WriteAllText(Path.Combine(sourceRoot, "LibraryView.axaml.cs"), `using System;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Interactivity;

namespace Issue2599.Fixture;

public partial class LibraryView : UserControl
{
    public LibraryView()
    {
        InitializeComponent();
    }

    protected override async void OnLoaded(RoutedEventArgs e)
    {
        await Task.Yield();
        base.OnLoaded(e);
    }

    protected override void OnUnloaded(RoutedEventArgs e)
    {
        if (DataContext is not State vm || booksGrid is null)
        {
            return;
        }

        vm.Count = booksGrid.Columns.Count;
        if (System.DateTime.UtcNow.Year > 0)
        {
            vm.Count++;
        }

        base.OnUnloaded(e);
    }
}

public sealed class State
{
    public int Count { get; set; }
}`)
            return projectPath
        }

        private func WriteIssue2641Project(sourceRoot string) string {
            let projectPath = Path.Combine(sourceRoot, "Issue2641.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.0" />
  </ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(sourceRoot, "A.GeneratedPart.cs"), `using CommunityToolkit.Mvvm.ComponentModel;

namespace Issue2641.Models;

public partial class BookItemViewModel : ObservableObject
{
    [ObservableProperty]
    private bool isSelected;
}`)
            File.WriteAllText(Path.Combine(sourceRoot, "B.SourcePart.cs"), `namespace Issue2641.Models;

public partial class BookItemViewModel
{
    private readonly string asin;

    public BookItemViewModel(string asin) => this.asin = asin;

    public string Asin => asin;
}`)
            File.WriteAllText(Path.Combine(sourceRoot, "C.View.cs"), `using Issue2641.Models;

namespace Issue2641.Views;

public sealed class Selection
{
    public string Asin { get; set; } = string.Empty;

    public BookItemViewModel Item { get; set; } = null!;
}

public sealed class View
{
    public void Copy(object context, object x)
    {
        (context as Selection)!.Asin = (x as BookItemViewModel)!.Asin;
        (context as Selection)!.Item = (x as BookItemViewModel)!;
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
            let root = Path.Combine(AppContext.BaseDirectory, "issue2599", category, Guid.NewGuid().ToString("N"))
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

// <copyright file="Issue2599AvaloniaCodebehindTests.cs" company="GSharp">
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

[CollectionDefinition("Issue2599NuGetEnvironment", DisableParallelization = true)]
public sealed class Issue2599NuGetEnvironmentCollection
{
}

[Collection("Issue2599NuGetEnvironment")]
public sealed class Issue2599AvaloniaCodebehindTests : IDisposable
{
    private readonly string previousNuGetPackages;

    public Issue2599AvaloniaCodebehindTests()
    {
        this.previousNuGetPackages = Environment.GetEnvironmentVariable("NUGET_PACKAGES");
        Environment.SetEnvironmentVariable(
            "NUGET_PACKAGES",
            NewDirectory("sdk-packages"));
    }

    [Fact]
    public async Task Pipeline_AvaloniaGeneratedPartialAndCodebehind_CompileTogether()
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
            new CorpusApp("test/AvaloniaCodebehind", projectPath, TargetKind.Library),
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
        string codebehind = File.ReadAllText(Path.Combine(appDirectory, "LibraryView.axaml.gs"));
        Assert.Contains("open partial class LibraryView : UserControl", codebehind, StringComparison.Ordinal);
        Assert.Contains("let vm State? = DataContext as State", codebehind, StringComparison.Ordinal);
        Assert.Contains("if vm == nil || booksGrid == nil", codebehind, StringComparison.Ordinal);
        Assert.Contains("__asyncVoid_OnLoaded(e)", codebehind, StringComparison.Ordinal);
        Assert.Contains("private async func __asyncVoid_OnLoaded(e RoutedEventArgs)", codebehind, StringComparison.Ordinal);
        Assert.Contains("base.OnLoaded(e)", codebehind, StringComparison.Ordinal);

        string generated = File.ReadAllText(Directory.GetFiles(
            Path.Combine(appDirectory, "obj"),
            "*LibraryView*.g.gs",
            SearchOption.AllDirectories).Single());
        Assert.Contains("var booksGrid DataGrid", generated, StringComparison.Ordinal);
        Assert.Contains("@System.CodeDom.Compiler.GeneratedCode", generated, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("NUGET_PACKAGES", this.previousNuGetPackages);
    }

    private static string WriteProject(string sourceRoot)
    {
        string packagesPath = Path.Combine(sourceRoot, "packages");
        File.WriteAllText(
            Path.Combine(sourceRoot, "Directory.Build.props"),
            $"""
             <Project>
               <PropertyGroup>
                 <RestorePackagesPath>{packagesPath}</RestorePackagesPath>
               </PropertyGroup>
             </Project>
             """);
        string projectPath = Path.Combine(sourceRoot, "AvaloniaCodebehind.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                <RootNamespace>Issue2599.Fixture</RootNamespace>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Avalonia" Version="11.2.7" />
                <PackageReference Include="Avalonia.Controls.DataGrid" Version="11.2.7" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(sourceRoot, "LibraryView.axaml"), """
            <UserControl
                x:Class="Issue2599.Fixture.LibraryView"
                xmlns="https://github.com/avaloniaui"
                xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
              <DataGrid x:Name="booksGrid" />
            </UserControl>
            """);
        File.WriteAllText(Path.Combine(sourceRoot, "LibraryView.axaml.cs"), """
            using System;
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
            "issue2599",
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

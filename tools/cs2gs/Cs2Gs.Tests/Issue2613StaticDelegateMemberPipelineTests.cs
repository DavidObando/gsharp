// <copyright file="Issue2613StaticDelegateMemberPipelineTests.cs" company="GSharp">
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

public sealed class Issue2613StaticDelegateMemberPipelineTests
{
    [Fact]
    public async Task Pipeline_StaticDelegatePropertyAndField_RemainAssignableAndInvocable()
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
        string projectPath = WriteFixture(sourceRoot);
        string outputRoot = NewDirectory("pipeline-tests");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2613", projectPath, TargetKind.Exe) });
        AppResult app = Assert.Single(result.Apps);
        Assert.True(
            app.Succeeded,
            "Expected translated static delegates to compile. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));

        string runDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));
        Assert.Contains("var Property (int32) -> int32", emitted, StringComparison.Ordinal);
        Assert.Contains("var Field (int32) -> int32", emitted, StringComparison.Ordinal);
        Assert.Contains("Factory.Property(2)", emitted, StringComparison.Ordinal);
        Assert.Contains("Factory.Field(2)", emitted, StringComparison.Ordinal);

        string assembly = Directory.GetFiles(
                Path.Combine(runDirectory, "bin"),
                "Issue2613.dll",
                SearchOption.AllDirectories)
            .Single(path => !path.Contains(
                Path.DirectorySeparatorChar + "ref" + Path.DirectorySeparatorChar,
                StringComparison.Ordinal));
        var startInfo = new ProcessStartInfo("dotnet", "\"" + assembly + "\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using var process = Process.Start(startInfo)!;
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(process.ExitCode == 0, error);
        Assert.Equal("12\n6\n", output.Replace("\r\n", "\n"));
    }

    private static string WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDirectory = Path.Combine(sourceRoot, "Issue2613");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Issue2613.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), """
            using System;

            public static class Factory
            {
                public static Func<int, int> Property { get; set; } = value => value + 1;
                public static Func<int, int> Field = value => value + 2;
            }

            Factory.Property = value => value + 10;
            Factory.Field = value => value * 3;
            Console.WriteLine(Factory.Property(2));
            Console.WriteLine(Factory.Field(2));
            """);
        return projectPath;
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2613",
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

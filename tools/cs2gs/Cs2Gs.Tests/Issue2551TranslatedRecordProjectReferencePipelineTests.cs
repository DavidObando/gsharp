// <copyright file="Issue2551TranslatedRecordProjectReferencePipelineTests.cs" company="GSharp">
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

/// <summary>
/// Issue #2551: a record translated in one project must retain data-class
/// semantics when an independently translated consumer sees its reference
/// assembly through a project reference.
/// </summary>
public sealed class Issue2551TranslatedRecordProjectReferencePipelineTests
{
    [Fact]
    public async Task Pipeline_TranslatedRecordProjectReference_WithCopy_Runs()
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
        Fixture fixture = WriteFixture(sourceRoot);
        RunDotnetBuild(fixture.ConsumerProject);

        string outputRoot = NewDirectory("pipeline-tests");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };
        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage(), new TestParityStage() });
        var result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/Models", fixture.ModelsProject, TargetKind.Library),
            new CorpusApp(
                "test/Consumer",
                fixture.ConsumerProject,
                TargetKind.Exe,
                stdoutGolden: fixture.StdoutGolden),
        });

        Assert.All(
            result.Apps,
            app => Assert.True(
                app.Succeeded,
                app.AppId + " should translate, compile, and run. Stages: "
                    + string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status))));

        string runDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId("test/Models"));
        string producer = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));
        Assert.Contains("data class Settings {", producer, StringComparison.Ordinal);
        Assert.Contains("prop Label string {", producer, StringComparison.Ordinal);
    }

    private static Fixture WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string modelsDirectory = Path.Combine(sourceRoot, "Models");
        Directory.CreateDirectory(modelsDirectory);
        string modelsProject = Path.Combine(modelsDirectory, "Models.csproj");
        File.WriteAllText(modelsProject, ProjectFile());
        File.WriteAllText(Path.Combine(modelsDirectory, "Settings.cs"), """
            namespace Models;

            public sealed record Settings
            {
                public string Label { get; init; } = "ready";

                public int Retries { get; init; } = 3;

                public static Settings Default => new();

                public static Models.Settings Copy(Models.Settings value)
                    => value with { Label = "producer" };
            }
            """);

        string consumerDirectory = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(consumerDirectory);
        string consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj");
        File.WriteAllText(consumerProject, ProjectFile("../Models/Models.csproj", outputType: "Exe"));
        File.WriteAllText(Path.Combine(consumerDirectory, "Program.cs"), """
            using System;
            var original = Models.Settings.Default;
            var produced = Models.Settings.Copy(original);
            var changed = Change(produced);
            var copied = changed with { Label = "copied" };

            Console.WriteLine(original.Label);
            Console.WriteLine(original.Retries);
            Console.WriteLine(produced.Label);
            Console.WriteLine(produced.Retries);
            Console.WriteLine(changed.Label);
            Console.WriteLine(changed.Retries);
            Console.WriteLine(copied.Label);
            Console.WriteLine(copied.Retries);

            static Models.Settings Change(Models.Settings value)
                => value with { Retries = 8 };
            """);

        string stdoutGolden = Path.Combine(sourceRoot, "baseline.stdout.golden");
        File.WriteAllText(stdoutGolden, "ready\n3\nproducer\n3\nproducer\n8\ncopied\n8\n");
        return new Fixture(modelsProject, consumerProject, stdoutGolden);
    }

    private static string ProjectFile(string projectReference = null, string outputType = null)
    {
        string output = outputType is null ? string.Empty : $"<OutputType>{outputType}</OutputType>";
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
                <Nullable>enable</Nullable>
                {output}
              </PropertyGroup>
              {reference}
            </Project>
            """;
    }

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add("build");
        startInfo.ArgumentList.Add(projectPath);
        startInfo.ArgumentList.Add("--nologo");
        startInfo.ArgumentList.Add("--verbosity:quiet");

        using Process process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, "Fixture build failed:\n" + stdout + stderr);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2551",
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

    private sealed record Fixture(string ModelsProject, string ConsumerProject, string StdoutGolden);
}

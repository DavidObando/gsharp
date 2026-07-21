// <copyright file="Issue2537ConcurrentDictionaryPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2537ConcurrentDictionaryPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdk_ConcurrentDictionaryOfInterface_DeconstructsAndRuns()
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
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2537", projectPath, TargetKind.Exe) });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(
            app.Succeeded,
            "Expected ConcurrentDictionary deconstruction to compile via gsc. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));

        string runDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.AppId));
        string assembly = Directory.GetFiles(
                Path.Combine(runDirectory, "bin"),
                "Issue2537.dll",
                SearchOption.AllDirectories)
            .Single(path => !path.Contains(
                Path.DirectorySeparatorChar + "ref" + Path.DirectorySeparatorChar,
                StringComparison.Ordinal));
        (int exitCode, string output) = RunDotnet($"\"{assembly}\"");

        Assert.Equal(0, exitCode);
        Assert.Equal("42" + Environment.NewLine, output);
    }

    private static string WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "Issue2537");
        Directory.CreateDirectory(projectDir);

        string projectPath = Path.Combine(projectDir, "Issue2537.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Program.cs"), """
            using System;
            using System.Collections.Concurrent;

            var values = new ConcurrentDictionary<string, IValue>();
            values.TryAdd("answer", new Value());
            foreach (var (key, value) in values)
            {
                Console.WriteLine(value.Number);
            }

            public interface IValue
            {
                int Number { get; }
            }

            public sealed class Value : IValue
            {
                public int Number => 42;
            }
            """);
        return projectPath;
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2537",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static (int ExitCode, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(startInfo);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
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
                    projectDirName,
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

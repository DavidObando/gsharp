// <copyright file="Issue2534ImportedBaseCallPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Project-backed compile and runtime coverage for imported base virtual calls.</summary>
public sealed class Issue2534ImportedBaseCallPipelineTests
{
    [Fact]
    public async Task Pipeline_ImportedFrameworkBaseCall_EmitsCanonicalSyntaxAndRuns()
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
        string projectDirectory = Path.Combine(sourceRoot, "ImportedBaseCall");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "ImportedBaseCall.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Exe</OutputType>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), """
            using System;
            using System.IO;

            namespace ImportedBaseCall;

            public sealed class RecordingStream : MemoryStream
            {
                public int Calls { get; private set; }

                public override void Write(byte[] buffer, int offset, int count)
                {
                    Calls++;
                    base.Write(buffer, offset, count);
                }
            }

            public static class Program
            {
                public static void Main()
                {
                    var stream = new RecordingStream();
                    stream.Write(new byte[] { 1, 2, 3 }, 0, 3);
                    Console.WriteLine(stream.Calls);
                    Console.WriteLine(stream.Length);
                    Console.WriteLine(stream.ToArray()[1]);
                }
            }
            """);
        string goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
        File.WriteAllText(goldenPath, "1\n3\n2\n");

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp(
            "test/ImportedBaseCall",
            projectPath,
            TargetKind.Exe,
            stdoutGolden: goldenPath);
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };
        Assert.True(options.CompileViaSdk);

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage(), new TestParityStage() });
        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        string runDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.Id));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("base.Write(buffer, offset, count)", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("base!!", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected imported base call to compile and preserve runtime behavior. Stages: "
                + string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2534",
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

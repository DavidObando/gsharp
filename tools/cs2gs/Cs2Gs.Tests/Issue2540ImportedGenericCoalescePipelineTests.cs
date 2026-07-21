// <copyright file="Issue2540ImportedGenericCoalescePipelineTests.cs" company="GSharp">
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

public sealed class Issue2540ImportedGenericCoalescePipelineTests
{
    [Fact]
    public async Task Pipeline_ImportedGenericLoggerCoalesce_Compiles()
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
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "Issue2540");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "Issue2540.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="10.0.5" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Service.cs"), """
            using Microsoft.Extensions.Logging;
            using Microsoft.Extensions.Logging.Abstractions;

            namespace Issue2540;

            public sealed class Service
            {
                private readonly ILogger<Service> logger;

                public Service(ILogger<Service>? logger = null)
                {
                    this.logger = logger ?? NullLogger<Service>.Instance;
                }
            }
            """);
        RunDotnetBuild(projectPath);

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
            new[] { new CorpusApp("test/Issue2540", projectPath, TargetKind.Library) });
        AppResult app = Assert.Single(result.Apps);
        string emitted = ReadAppOutput(outputRoot, result.RunId, app.AppId);

        Assert.Contains("logger ?? NullLogger[Service].Instance", emitted, StringComparison.Ordinal);
        Assert.True(
            app.Succeeded,
            "Expected imported generic logger coalescing to compile via gsc. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string ReadAppOutput(string outputRoot, string runId, string appId)
    {
        string directory = Path.Combine(outputRoot, runId, MigrationPipeline.SanitizeAppId(appId));
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
            "issue2540",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
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

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo(
            "dotnet",
            $"build \"{projectPath}\" --nologo --verbosity:quiet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1";

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to build issue #2540 fixture.");
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, "Fixture build failed:\n" + stdout + stderr);
    }
}

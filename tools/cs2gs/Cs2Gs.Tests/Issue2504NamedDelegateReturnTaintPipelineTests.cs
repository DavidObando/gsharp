// <copyright file="Issue2504NamedDelegateReturnTaintPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Default SDK-backed/gsc sink coverage for issue #2504, including the
/// cross-project delegate-declaration/producer shape used by real corpora.
/// </summary>
public sealed class Issue2504NamedDelegateReturnTaintPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_CrossProjectNamedDelegateReturn_TranslatesAndCompiles()
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
        (string contractsProject, string producerProject) = WriteFixture(sourceRoot);
        string outputRoot = NewDirectory("pipeline-tests");
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,
        };
        Assert.True(options.CompileViaSdk);

        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        RunResult result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/Contracts", contractsProject, TargetKind.Library),
            new CorpusApp("test/Producer", producerProject, TargetKind.Library),
        });

        Assert.All(
            result.Apps,
            app => Assert.True(
                app.Succeeded,
                $"Expected default --via-sdk/gsc compilation to succeed for {app.AppId}. Stages: " +
                    string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status))));

        string contracts = ReadAppOutput(outputRoot, result.RunId, "test_Contracts");
        string producer = ReadAppOutput(outputRoot, result.RunId, "test_Producer");
        Assert.Contains("class Result", contracts, StringComparison.Ordinal);
        Assert.Contains("type Callback = delegate func(enforce bool = false) Result?", producer, StringComparison.Ordinal);
        Assert.Contains("callback ((bool) -> Result?)?", producer, StringComparison.Ordinal);
        Assert.Contains("func Produce(enforce bool) Result? -> nil", producer, StringComparison.Ordinal);
        Assert.Contains("Holder(Produce)", producer, StringComparison.Ordinal);
        Assert.DoesNotContain("Produce!!", producer, StringComparison.Ordinal);
    }

    private static (string ContractsProject, string ProducerProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string contractsDir = Path.Combine(sourceRoot, "Contracts");
        Directory.CreateDirectory(contractsDir);
        string contractsProject = Path.Combine(contractsDir, "Contracts.csproj");
        File.WriteAllText(contractsProject, ProjectFile(projectReference: null));
        File.WriteAllText(Path.Combine(contractsDir, "Contracts.cs"), """
            namespace Contracts;

            public sealed class Result { }
            """);

        string producerDir = Path.Combine(sourceRoot, "Producer");
        Directory.CreateDirectory(producerDir);
        string producerProject = Path.Combine(producerDir, "Producer.csproj");
        File.WriteAllText(
            producerProject,
            ProjectFile(Path.GetRelativePath(producerDir, contractsProject)));
        File.WriteAllText(Path.Combine(producerDir, "Repro.cs"), """
            using Contracts;

            namespace Producer;

            public delegate Result Callback(bool enforce = false);

            public sealed class Holder
            {
                private readonly Callback callback;

                public Holder(Callback callback) => this.callback = callback;

                public Result Run(bool enforce = false) => callback?.Invoke(enforce);
            }

            public static class Repro
            {
                private static Result Produce(bool enforce) => null;

                public static Holder Create() => new Holder(Produce);
            }
            """);

        return (contractsProject, producerProject);
    }

    private static string ProjectFile(string projectReference) =>
        projectReference is null
            ? """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFramework>net10.0</TargetFramework>
                  </PropertyGroup>
                </Project>
                """
            : $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFramework>net10.0</TargetFramework>
                  </PropertyGroup>
                  <ItemGroup>
                    <ProjectReference Include="{projectReference}" />
                  </ItemGroup>
                </Project>
                """;

    private static string ReadAppOutput(string outputRoot, string runId, string appDirectory)
    {
        string directory = Path.Combine(outputRoot, runId, appDirectory);
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
            "issue2504",
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
}

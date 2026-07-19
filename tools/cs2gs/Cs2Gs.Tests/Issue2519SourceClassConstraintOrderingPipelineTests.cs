// <copyright file="Issue2519SourceClassConstraintOrderingPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Default SDK-backed Oahu.Decrypt constraint-shape coverage for issue #2519.</summary>
public sealed class Issue2519SourceClassConstraintOrderingPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_SourceClassConstraintsCompileBeforeTheirDeclarations()
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
        string projectDir = Path.Combine(sourceRoot, "src", "OahuDecryptConstraintShape");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "OahuDecryptConstraintShape.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        WriteSources(projectDir);

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp("test/OahuDecryptConstraintShape2519", projectPath, TargetKind.Library);
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
        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.Id));
        string project = File.ReadAllText(Assert.Single(
            Directory.GetFiles(appRunDir, "*.gsproj", SearchOption.AllDirectories)));

        Assert.Contains("AHolder.gs", project, StringComparison.Ordinal);
        Assert.Contains("AMultipartFilterBase.gs", project, StringComparison.Ordinal);
        Assert.Contains("ZEntry.gs", project, StringComparison.Ordinal);
        Assert.True(
            project.IndexOf("AHolder.gs", StringComparison.Ordinal)
                < project.IndexOf("ZEntry.gs", StringComparison.Ordinal));
        Assert.True(
            project.IndexOf("AMultipartFilterBase.gs", StringComparison.Ordinal)
                < project.IndexOf("ZEntry.gs", StringComparison.Ordinal));
        Assert.True(
            appResult.Succeeded,
            "Expected path-ordered default --via-sdk compilation to resolve source class constraints. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static void WriteSources(string projectDir)
    {
        File.WriteAllText(Path.Combine(projectDir, "AHolder.cs"), """
            using P;

            namespace P.Audio;

            public class Holder<T> where T : Entry
            {
                public int Read(T value) => value.Count;
            }
            """);
        File.WriteAllText(Path.Combine(projectDir, "AMultipartFilterBase.cs"), """
            using System.Threading.Tasks;

            namespace Oahu.Decrypt.FrameFilters.Audio;

            public abstract class MultipartFilterBase<TInput, TCallback> : FrameFinalBase<TInput>
                where TInput : FrameEntry
                where TCallback : Oahu.Decrypt.INewSplitCallback<TCallback>
            {
                protected override Task PerformFilteringAsync(TInput input)
                {
                    if (input.Chunk is null)
                    {
                        input.Chunk = new object();
                    }

                    input.SamplesInFrame += 1;
                    return Task.CompletedTask;
                }
            }
            """);
        File.WriteAllText(Path.Combine(projectDir, "YFrameFinalBase.cs"), """
            using System.Threading.Tasks;

            namespace Oahu.Decrypt.FrameFilters.Audio;

            public abstract class FrameFinalBase<T>
            {
                protected virtual Task PerformFilteringAsync(T input) => Task.CompletedTask;
            }
            """);
        File.WriteAllText(Path.Combine(projectDir, "ZEntry.cs"), """
            namespace P
            {
                public class Entry
                {
                    public int Count { get; set; }
                }
            }

            namespace Oahu.Decrypt
            {
                public interface INewSplitCallback<T> where T : INewSplitCallback<T>
                {
                }
            }

            namespace Oahu.Decrypt.FrameFilters.Audio
            {
                public class FrameEntry
                {
                    public object? Chunk { get; set; }
                    public int SamplesInFrame { get; set; }
                }
            }
            """);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2519",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    dir.FullName,
                    "out",
                    "bin",
                    config,
                    projectDirName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}

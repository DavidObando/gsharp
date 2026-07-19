// <copyright file="Issue2517ConstructedBaseOrderingPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Default SDK-backed Oahu.Decrypt ordering-shape coverage for issue #2517.</summary>
public sealed class Issue2517ConstructedBaseOrderingPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_EarlyGenericSignatureAndOahuFilterShape_CompileInPathOrder()
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
        string projectDir = Path.Combine(sourceRoot, "src", "OahuDecryptShape");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "OahuDecryptShape.csproj");
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
        var app = new CorpusApp("test/OahuDecryptShape2517", projectPath, TargetKind.Library);
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

        Assert.True(project.IndexOf("0Early.gs", StringComparison.Ordinal) >= 0);
        Assert.True(
            project.IndexOf("0Early.gs", StringComparison.Ordinal)
                < project.IndexOf("ADerived.gs", StringComparison.Ordinal));
        Assert.True(
            project.IndexOf("ADerived.gs", StringComparison.Ordinal)
                < project.IndexOf("YMiddle.gs", StringComparison.Ordinal));
        Assert.True(
            project.IndexOf("YMiddle.gs", StringComparison.Ordinal)
                < project.IndexOf("ZBase.gs", StringComparison.Ordinal));
        Assert.True(
            appResult.Succeeded,
            "Expected path-ordered default --via-sdk compilation to preserve the constructed generic base. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static void WriteSources(string projectDir)
    {
        File.WriteAllText(Path.Combine(projectDir, "0Early.cs"), """
            using Oahu.Decrypt;

            namespace Other;

            public sealed class Early
            {
                public Middle<Entry, Entry>? Get() => null;
            }
            """);
        File.WriteAllText(Path.Combine(projectDir, "ADerived.cs"), """
            using Oahu.Decrypt;

            namespace Oahu.Decrypt.FrameFilters.Audio;

            public sealed class AacValidateFilter : Middle<Entry, Entry>
            {
                public AacValidateFilter() : base(1) { }

                protected override int InputBufferSize => 100;

                public int Inspect() =>
                    InputBufferSize + SamplesInFrame + (Disposed ? 0 : 1) + (Chunk is null ? 1 : 0);

                public void Report() => OnProgressUpdate();
            }
            """);
        File.WriteAllText(Path.Combine(projectDir, "Entry.cs"), """
            namespace Oahu.Decrypt;

            public sealed class Entry { }
            """);
        File.WriteAllText(Path.Combine(projectDir, "YMiddle.cs"), """
            namespace Oahu.Decrypt;

            public abstract class Middle<TInput, TOutput> : Base<TInput>
            {
                protected Middle(int seed) : base(seed) { }
            }
            """);
        File.WriteAllText(Path.Combine(projectDir, "ZBase.cs"), """
            namespace Oahu.Decrypt;

            public abstract class Base<T>
            {
                protected Base(int seed) => SamplesInFrame = seed;

                protected abstract int InputBufferSize { get; }
                protected bool Disposed { get; }
                protected T? Chunk { get; }
                protected int SamplesInFrame { get; }
                protected void OnProgressUpdate() { }
            }
            """);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2517",
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

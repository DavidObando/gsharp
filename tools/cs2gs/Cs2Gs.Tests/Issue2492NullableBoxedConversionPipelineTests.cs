// <copyright file="Issue2492NullableBoxedConversionPipelineTests.cs" company="GSharp">
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
/// Issue #2492: the default SDK-backed migration emits nullable value-type
/// construction for an explicit cast from <c>object?</c>, and gsc must accept
/// both the stable minimal repro and the Oahu converter shape.
/// </summary>
public sealed class Issue2492NullableBoxedConversionPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_NullableObjectCast_TranslatesAndCompiles()
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
        string projectDir = Path.Combine(sourceRoot, "src", "Sample");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "Sample.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), """
            namespace Sample;

            public static class Repro
            {
                public static uint? Convert(object? value) => (uint?)value;
            }

            public sealed class ToStringConverterActivationCode
            {
                public uint? Convert(object? value)
                {
                    uint? ac = (uint?)value;
                    return ac;
                }
            }
            """);

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp("test/NullableBoxedConversion", projectPath, TargetKind.Library);
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
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains(
            "func Convert(value object?) uint32? -> uint32?(value)",
            emitted,
            StringComparison.Ordinal);
        Assert.Contains("class ToStringConverterActivationCode", emitted, StringComparison.Ordinal);
        Assert.Contains("let ac = uint32?(value)", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk compile to accept nullable boxed conversions. Stages: " +
                string.Join("; ", appResult.Stages.Select(s => s.Stage + "=" + s.Status)));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2492",
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

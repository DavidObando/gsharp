// <copyright file="Issue2494EnumLinqExtremaPipelineTests.cs" company="GSharp">
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
/// Issue #2494: the default SDK-backed migration must compile both the minimal
/// enum-array Min shape and the Select/Distinct/Min pipeline that exposed the
/// same symbolic enum erasure in Oahu.
/// </summary>
public sealed class Issue2494EnumLinqExtremaPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_SourceEnumMinShapes_TranslateAndCompile()
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
            using System.Collections.Generic;
            using System.Linq;

            namespace Sample;

            public enum Choice { Low, High }
            public enum EConversionState { None, Partial, Complete }

            public sealed class Conversion
            {
                public EConversionState ApplicableState() => EConversionState.Complete;
            }

            public sealed class Component
            {
                public required Conversion Conversion { get; init; }
            }

            public sealed class Book
            {
                public required List<Component> Components { get; init; }
            }

            public static class Repro
            {
                public static Choice Pick() =>
                    new[] { Choice.Low, Choice.High }.Min();

                public static EConversionState ApplicableState(Book book)
                {
                    var state = book.Components
                        .Select(c => c.Conversion.ApplicableState())
                        .Distinct()
                        .Min();
                    return state;
                }
            }
            """);

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp("test/EnumLinqExtrema", projectPath, TargetKind.Library);
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

        Assert.Contains("func Pick() Choice", emitted, StringComparison.Ordinal);
        Assert.Contains("[]Choice{Choice.Low, Choice.High}.Min()", emitted, StringComparison.Ordinal);
        Assert.Contains("func ApplicableState(book Book) EConversionState", emitted, StringComparison.Ordinal);
        Assert.Contains(".Distinct().Min()", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk compile to preserve source enum identity through Min. Stages: " +
                string.Join("; ", appResult.Stages.Select(s => s.Stage + "=" + s.Status)));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2494",
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

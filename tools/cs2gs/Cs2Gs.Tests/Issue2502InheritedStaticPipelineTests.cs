// <copyright file="Issue2502InheritedStaticPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Default SDK-backed migration coverage for issue #2502.</summary>
public sealed class Issue2502InheritedStaticPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_InheritedGenericStaticCalls_TranslateAndCompile()
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

            public class Factory<T>
            {
                public static T Create() => default!;
            }

            public sealed class Product : Factory<Product>
            {
            }

            public abstract class Serialization<T>
            {
                public static T Deserialize(string json) => default!;
            }

            public sealed class LicenseResponse : Serialization<LicenseResponse>
            {
            }

            public static class Repro
            {
                public static Product Make() => Product.Create();

                public static LicenseResponse Parse(string response) =>
                    LicenseResponse.Deserialize(response);
            }
            """);

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp("test/InheritedStatic2502", projectPath, TargetKind.Library);
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

        Assert.Contains("Product.Create()", emitted, StringComparison.Ordinal);
        Assert.Contains("LicenseResponse.Deserialize(response)", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to bind inherited generic statics. Stages: " +
                string.Join("; ", appResult.Stages.Select(s => s.Stage + "=" + s.Status)));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2502",
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

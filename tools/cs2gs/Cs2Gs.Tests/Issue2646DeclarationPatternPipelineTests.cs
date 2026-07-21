// <copyright file="Issue2646DeclarationPatternPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2646DeclarationPatternPipelineTests
{
    [Fact]
    public async Task Pipeline_OahuNullableIntDeclarationPattern_Compiles()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string sourceRoot = NewDirectory("source");
        string projectPath = Path.Combine(sourceRoot, "Issue2646.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(sourceRoot, "Program.cs"), """
            namespace Oahu.Cli;

            public static class Program
            {
                public static int Run(int? rewriteCode)
                {
                    if (rewriteCode is int code)
                    {
                        return code;
                    }

                    return -1;
                }
            }
            """);

        string outputRoot = NewDirectory("output");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/Issue2646", projectPath, TargetKind.Library),
        });
        AppResult app = Assert.Single(result.Apps);
        Assert.True(
            app.Succeeded,
            string.Join(
                Environment.NewLine,
                app.Artifacts.Select(path => File.ReadAllText(Path.Combine(
                    outputRoot,
                    result.RunId,
                    path)))));

        string translated = File.ReadAllText(Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.AppId),
            "Program.gs"));
        Assert.Contains("let code = rewriteCode", translated, StringComparison.Ordinal);
        Assert.Contains("if code is int32", translated, StringComparison.Ordinal);
        Assert.DoesNotContain("return rewriteCode", translated, StringComparison.Ordinal);
    }

    private static string NewDirectory(string category)
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2646",
            category,
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
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

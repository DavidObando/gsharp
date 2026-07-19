// <copyright file="Issue2486ImplicitObjectOverridePipelineTests.cs" company="GSharp">
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
/// Issue #2486: ordinary C# classes do not spell an <c>object</c> base, so the
/// default SDK-backed migration path must compile their preserved overrides
/// against gsc's implicit <see cref="object"/> base.
/// </summary>
public sealed class Issue2486ImplicitObjectOverridePipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_ImplicitObjectOverrides_TranslateAndCompile()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null || repoRoot is null ||
            GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
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
                <OutputType>Exe</OutputType>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Program.cs"), """
            using System;

            namespace Sample;

            public sealed class Widget
            {
                public override string ToString() => "widget";

                public override int GetHashCode() => 2486;

                public override bool Equals(object? value) => true;
            }

            public static class Program
            {
                public static void Main()
                {
                    object value = new Widget();
                    Console.WriteLine(value.ToString());
                    Console.WriteLine(value.GetHashCode());
                    Console.WriteLine(value.Equals(new Widget()));
                }
            }
            """);

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp("test/ImplicitObject", projectPath, TargetKind.Exe);
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

        Assert.Contains("class Widget", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("class Widget : Object", emitted, StringComparison.Ordinal);
        Assert.Contains("override func ToString", emitted, StringComparison.Ordinal);
        Assert.Contains("override func GetHashCode", emitted, StringComparison.Ordinal);
        Assert.Contains("override func Equals", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected the default --via-sdk compile to accept implicit Object overrides. Stages: " +
                string.Join("; ", appResult.Stages.Select(s => s.Stage + "=" + s.Status)));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2486",
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

// <copyright file="Issue2506PromotedCallReceiverForgivenessPipelineTests.cs" company="GSharp">
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
/// Default <c>--via-sdk</c>/gsc sink coverage for the minimal issue #2506
/// promoted-call receiver and the Oahu <c>FromCountryCode(...).Domain</c>
/// extension-call shape.
/// </summary>
public sealed class Issue2506PromotedCallReceiverForgivenessPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_PromotedSameProjectCallReceivers_TranslateAndCompile()
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
        string projectPath = WriteFixture(sourceRoot);
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
        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/Issue2506", projectPath, TargetKind.Library) });
        AppResult appResult = Assert.Single(result.Apps);

        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(appResult.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("Repro.Find(false)!!.Name", emitted, StringComparison.Ordinal);
        Assert.Contains(
            "Locale.FromCountryCode(region)!!.Domain",
            emitted,
            StringComparison.Ordinal);
        Assert.Contains("Repro.FindFactory()!!().Name", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept promoted same-project call receivers. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static string WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "Issue2506");
        Directory.CreateDirectory(projectDir);

        string projectPath = Path.Combine(projectDir, "Issue2506.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), """
            using System;

            namespace Issue2506;

            public sealed class Item
            {
                public string Name { get; } = "item";
            }

            public enum ERegion
            {
                Unknown,
            }

            public interface ILocale
            {
                string Domain { get; }
            }

            public sealed class LocaleValue : ILocale
            {
                public string Domain { get; } = "example.test";
            }

            public static class Locale
            {
                public static ILocale FromCountryCode(this ERegion region) => null;
            }

            public static class Repro
            {
                private static Item Find(bool found) => found ? new Item() : null;
                private static Func<Item> FindFactory() => null;

                public static string Read() => Find(false).Name;
                public static string ReadFactory() => FindFactory()().Name;
                public static string ReadDomain(ERegion region) =>
                    Locale.FromCountryCode(region).Domain;
            }
            """);

        return projectPath;
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2506",
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

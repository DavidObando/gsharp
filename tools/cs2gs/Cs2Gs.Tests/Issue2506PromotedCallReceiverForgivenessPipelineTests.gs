// <copyright file="Issue2506PromotedCallReceiverForgivenessPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Default `--via-sdk`/gsc sink coverage for the minimal issue #2506
/// promoted-call receiver and the Oahu `FromCountryCode(...).Domain`
/// extension-call shape.
class Issue2506PromotedCallReceiverForgivenessPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_PromotedSameProjectCallReceivers_TranslateAndCompile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectPath = WriteFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2506", projectPath, TargetKind.Library)})
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(appResult.AppId))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("Find(false)!!.Name", emitted, StringComparison.Ordinal)
        Assert.Contains("region.FromCountryCode()!!.Domain", emitted, StringComparison.Ordinal)
        Assert.Contains("FindFactory()!!().Name", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept promoted same-project call receivers. Stages: " +
                string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
    }

    shared {
        private func WriteFixture(sourceRoot string) string {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let projectDir = Path.Combine(sourceRoot, "Issue2506")
            Directory.CreateDirectory(projectDir)
            let projectPath = Path.Combine(projectDir, "Issue2506.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), `using System;

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
}`)
            return projectPath
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2506", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirName string, dllName string) string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(
                        directory.FullName,
                        "out",
                        "bin",
                        configuration,
                        projectDirName,
                        dllName
                    )
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}

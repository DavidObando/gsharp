// <copyright file="Issue2511NullableIndexArgumentForgivenessPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// Default `--via-sdk`/gsc sink coverage for issue #2511, covering the
/// minimal dictionary repro plus source and imported/cross-project custom
/// indexers.
class Issue2511NullableIndexArgumentForgivenessPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_IndexArgumentForgiveness_TranslatesAndCompiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let (apiProject, appProject) = WriteFixture(sourceRoot)
        RunDotnetBuild(apiProject)
        let outputRoot = NewDirectory("pipeline-tests")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        Assert.True(options.CompileViaSdk)
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2511", appProject, TargetKind.Library)})
        let appResult = Assert.Single(result.Apps)
        let emitted = ReadAppOutput(outputRoot, result.RunId, appResult.AppId)
        AssertMatches(emitted, "items\\[[^\\]]*key!![^\\]]*\\]\\s*=\\s*\"value\"")
        AssertMatches(emitted, "items\\[[^\\]]*key!![^\\]]*\\]")
        AssertMatches(emitted, "imported\\[[^\\]]*key!![^\\]]*\\]")
        AssertMatches(emitted, "generic\\[[^\\]]*key!![^\\]]*\\]")
        AssertMatches(emitted, "counts\\[[^\\]]*key!![^\\]]*\\]\\s*\\+=\\s*1")
        Assert.Contains("local[key] = second", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("local[key!!]", emitted, StringComparison.Ordinal)
        Assert.Contains("nullable[key] = second", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("nullable[key!!]", emitted, StringComparison.Ordinal)
        Assert.Contains("array[i]", emitted, StringComparison.Ordinal)
        Assert.Contains("span[i]", emitted, StringComparison.Ordinal)
        Assert.Contains("text[i]", emitted, StringComparison.Ordinal)
        Assert.Contains("array[^1]", emitted, StringComparison.Ordinal)
        Assert.Contains("text[1 .. ^1]", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept nullable-oblivious index arguments. Stages: " +
                string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
    }

    shared {
        private func WriteFixture(sourceRoot string)(ApiProject string, AppProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let apiDir = Path.Combine(sourceRoot, "Api")
            let appDir = Path.Combine(sourceRoot, "Issue2511")
            Directory.CreateDirectory(apiDir)
            Directory.CreateDirectory(appDir)
            let apiProject = Path.Combine(apiDir, "Api.csproj")
            File.WriteAllText(apiProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(apiDir, "Api.cs"), `#nullable disable
namespace ExternalApi;

public sealed class ImportedLookup
{
    public string this[string key]
    {
        get => key ?? "";
        set { }
    }
}

public sealed class GenericLookup<TKey>
    where TKey : class
{
    public string this[TKey key] => key.ToString();
}

public static class ImportedUsage
{
    private static string FindKey() =>
        System.Environment.GetEnvironmentVariable("SIBLING_KEY");

    public static string Read(ImportedLookup lookup)
    {
        string key = FindKey();
        return lookup[key];
    }
}

#nullable enable
public sealed class NullableLookup
{
    public string this[string? key]
    {
        get => key ?? "";
        set { }
    }
}`)
            let appProject = Path.Combine(appDir, "Issue2511.csproj")
            File.WriteAllText(appProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Api/Api.csproj" />
  </ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(appDir, "Repro.cs"), `using System;
using System.Collections.Generic;
using ExternalApi;

namespace Issue2511;

public sealed class LocalLookup
{
    public string this[string key]
    {
        get => key ?? "";
        set { }
    }
}

public static class Repro
{
    private static string FindKey(bool ok) => ok ? "key" : null;

    public static string Run(
        Dictionary<string, string> items,
        Dictionary<string, int> counts,
        LocalLookup local,
        ImportedLookup imported,
        GenericLookup<string> generic,
        NullableLookup nullable,
        int[] array,
        string text,
        int i,
        bool ok)
    {
        string key = FindKey(ok);
        items[key] = "value";
        string first = items[key];
        string second = imported[key];
        local[key] = second;
        string third = local[key];
        string fourth = generic[key];
        counts[key] += 1;
        nullable[key] = second;
        Span<int> span = array;
        return fourth + first + third + nullable[key]
            + (array[i] + span[i] + text[i] + array[^1] + text[1..^1].Length).ToString();
    }
}`)
            return (apiProject, appProject)
        }

        private func RunDotnetBuild(projectPath string) {
            let startInfo = ProcessStartInfo("dotnet", "build \"$projectPath\" --nologo --verbosity:quiet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1"
            using let process Process? = Process.Start(startInfo)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.True(process!!.ExitCode == 0, "Failed to prebuild API project:\n" + stdout + stderr)
        }

        private func ReadAppOutput(outputRoot string, runId string, appId string) string {
            let directory = Path.Combine(outputRoot, runId, MigrationPipeline.SanitizeAppId(appId))
            return string.Join(
                Environment.NewLine,
                Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
            )
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2511", Guid.NewGuid().ToString("N"))
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

        private func AssertMatches(text string, pattern string) -> Assert.Matches(
            Regex(pattern, RegexOptions.Singleline | RegexOptions.CultureInvariant),
            text
        )
    }
}

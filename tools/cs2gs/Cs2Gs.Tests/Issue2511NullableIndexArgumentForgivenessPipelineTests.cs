// <copyright file="Issue2511NullableIndexArgumentForgivenessPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Default <c>--via-sdk</c>/gsc sink coverage for issue #2511, covering the
/// minimal dictionary repro plus source and imported/cross-project custom
/// indexers.
/// </summary>
public sealed class Issue2511NullableIndexArgumentForgivenessPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_IndexArgumentForgiveness_TranslatesAndCompiles()
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
        (string apiProject, string appProject) = WriteFixture(sourceRoot);
        RunDotnetBuild(apiProject);

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
            new[] { new CorpusApp("test/Issue2511", appProject, TargetKind.Library) });
        AppResult appResult = Assert.Single(result.Apps);

        string emitted = ReadAppOutput(outputRoot, result.RunId, appResult.AppId);
        AssertMatches(emitted, @"items\[[^\]]*key!![^\]]*\]\s*=\s*""value""");
        AssertMatches(emitted, @"items\[[^\]]*key!![^\]]*\]");
        AssertMatches(emitted, @"imported\[[^\]]*key!![^\]]*\]");
        AssertMatches(emitted, @"generic\[[^\]]*key!![^\]]*\]");
        AssertMatches(emitted, @"counts\[[^\]]*key!![^\]]*\]\s*\+=\s*1");
        Assert.Contains("local[key] = second", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("local[key!!]", emitted, StringComparison.Ordinal);
        Assert.Contains("nullable[key] = second", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("nullable[key!!]", emitted, StringComparison.Ordinal);
        Assert.Contains("array[i]", emitted, StringComparison.Ordinal);
        Assert.Contains("span[i]", emitted, StringComparison.Ordinal);
        Assert.Contains("text[i]", emitted, StringComparison.Ordinal);
        Assert.Contains("array[^1]", emitted, StringComparison.Ordinal);
        Assert.Contains("text[1..^1]", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept nullable-oblivious index arguments. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    private static (string ApiProject, string AppProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string apiDir = Path.Combine(sourceRoot, "Api");
        string appDir = Path.Combine(sourceRoot, "Issue2511");
        Directory.CreateDirectory(apiDir);
        Directory.CreateDirectory(appDir);

        string apiProject = Path.Combine(apiDir, "Api.csproj");
        File.WriteAllText(apiProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(apiDir, "Api.cs"), """
            #nullable disable
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
            }
            """);

        string appProject = Path.Combine(appDir, "Issue2511.csproj");
        File.WriteAllText(appProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
              <ItemGroup>
                <ProjectReference Include="../Api/Api.csproj" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(appDir, "Repro.cs"), """
            using System;
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
            }
            """);

        return (apiProject, appProject);
    }

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo(
            "dotnet",
            $"build \"{projectPath}\" --nologo --verbosity:quiet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1";

        using var process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(
            process.ExitCode == 0,
            "Failed to prebuild API project:\n" + stdout + stderr);
    }

    private static string ReadAppOutput(string outputRoot, string runId, string appId)
    {
        string directory = Path.Combine(
            outputRoot,
            runId,
            MigrationPipeline.SanitizeAppId(appId));
        return string.Join(
            Environment.NewLine,
            Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2511",
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

    private static void AssertMatches(string text, string pattern) =>
        Assert.Matches(new Regex(pattern, RegexOptions.Singleline | RegexOptions.CultureInvariant), text);
}

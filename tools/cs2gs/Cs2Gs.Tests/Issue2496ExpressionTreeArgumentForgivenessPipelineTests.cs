// <copyright file="Issue2496ExpressionTreeArgumentForgivenessPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// End-to-end default <c>--via-sdk</c> coverage for issue #2496 using an
/// oblivious sibling assembly that exposes EF-style expression-tree sinks.
/// </summary>
public sealed class Issue2496ExpressionTreeArgumentForgivenessPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_ObliviousExpressionSinks_TranslateAndCompile()
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
            new[] { new CorpusApp("test/ExpressionConsumer", appProject, TargetKind.Library) });
        AppResult appResult = Assert.Single(result.Apps);

        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(appResult.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        // ADR-0179 phase 7b: the gsfmt post-pass wraps the two over-wide calls
        // in this chain. What issue #2496 asserts is which arguments carry a
        // `!!`, never where the line breaks, so these match the construct and
        // let the formatter own the layout — see ContainsIgnoringWrap.
        ContainsIgnoringWrap("HasKey((item Item) -> item.Id)", emitted);
        ContainsIgnoringWrap("HasIndex((item Item) -> item.Name)", emitted);
        ContainsIgnoringWrap("HasForeignKey((item Item) ->", emitted);
        ContainsIgnoringWrap("(item Item) -> item.Name!!)", emitted);
        ContainsIgnoringWrap("Selector[Item]((item Item) -> item.Id)", emitted);
        Assert.Contains("OverloadSink.Select", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("item.Id!!", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("item.ParentId!!", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("child.Name!!", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept all expression-tree sinks. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    /// <summary>Collapses every run of whitespace to one space.</summary>

    private static (string ApiProject, string AppProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string apiDir = Path.Combine(sourceRoot, "Api");
        string appDir = Path.Combine(sourceRoot, "ExpressionConsumer");
        Directory.CreateDirectory(apiDir);
        Directory.CreateDirectory(appDir);

        string apiProject = Path.Combine(apiDir, "Api.csproj");
        File.WriteAllText(apiProject, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(apiDir, "Api.cs"), """
            using System;
            using System.Linq.Expressions;

            namespace ExpressionApi;

            public sealed class ModelBuilder
            {
                public EntityBuilder<T> Entity<T>() => new();
            }

            public sealed class EntityBuilder<T>
            {
                public EntityBuilder<T> HasKey(Expression<Func<T, object>> selector) => this;
                public EntityBuilder<T> HasIndex(Expression<Func<T, string>> selector) => this;
                public EntityBuilder<T> HasForeignKey(Expression<Func<T, object>> selector) => this;
                public EntityBuilder<T> Runtime(Func<T, string> selector) => this;
            }

            public sealed class Selector<T>
            {
                public Selector(Expression<Func<T, object>> selector) { }
            }

            public static class OverloadSink
            {
                public static void Select<T>(Expression<Func<T, string>> selector) { }
                public static void Select<T>(Func<T, int> selector) { }
            }
            """);

        string appProject = Path.Combine(appDir, "ExpressionConsumer.csproj");
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
        File.WriteAllText(Path.Combine(appDir, "Model.cs"), """
            using ExpressionApi;

            namespace ExpressionConsumer;

            public sealed class Item
            {
                public int Id { get; set; }
                public int? ParentId { get; set; }
                public Item Other { get; set; }
                public string Name => Other?.Name;
            }

            public sealed class Context
            {
                public void Configure(ModelBuilder modelBuilder)
                {
                    modelBuilder.Entity<Item>()
                        .HasKey(item => item.Id)
                        .HasIndex(item => item.Name)
                        .HasForeignKey(item => new { item.Id, item.ParentId })
                        .Runtime(item => item.Name);

                    _ = new Selector<Item>(item => item.Id);
                    OverloadSink.Select((Item item) => item.Name);
                    OverloadSink.Select((Item item) => item.Id);
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
            "Failed to prebuild expression sink project:\n" + stdout + stderr);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2496",
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

    /// <summary>
    /// ADR-0179 phase 7b: asserts that <paramref name="actual"/> contains the
    /// construct <paramref name="expected"/> describes, without pinning where
    /// the formatter chose to break lines.
    /// <para>
    /// Write <paramref name="expected"/> in its unwrapped form. Whitespace is
    /// tolerated wherever a line break can legally sit — beside a bracket or a
    /// comma — and REQUIRED where the expectation puts it between two ordinary
    /// tokens, because `item Item` and `itemItem` are different programs. A
    /// blunt strip-all-whitespace comparison would accept the second, trading
    /// this test's brittleness for a hole in what it discriminates; the whole
    /// point of these assertions is which arguments carry a `!!`.
    /// </para>
    /// </summary>
    /// <param name="expected">The construct, written unwrapped.</param>
    /// <param name="actual">The emitted G#, raw and unnormalised.</param>
    private static void ContainsIgnoringWrap(string expected, string actual)
    {
        static bool IsToken(char c) => char.IsLetterOrDigit(c) || c is '_' or '.' or '!' or '?';

        var pattern = new StringBuilder();
        for (int i = 0; i < expected.Length; i++)
        {
            char c = expected[i];
            if (char.IsWhiteSpace(c))
            {
                int start = i;
                while (i + 1 < expected.Length && char.IsWhiteSpace(expected[i + 1]))
                {
                    i++;
                }

                bool boundedByTokens = start > 0
                    && IsToken(expected[start - 1])
                    && i + 1 < expected.Length
                    && IsToken(expected[i + 1]);
                pattern.Append(boundedByTokens ? "\\s+" : "\\s*");
                continue;
            }

            if (c is ')' or ']' or '}')
            {
                pattern.Append("\\s*");
            }

            pattern.Append(Regex.Escape(c.ToString()));

            if (c is '(' or '[' or '{' or ',')
            {
                pattern.Append("\\s*");
            }
        }

        Assert.True(
            Regex.IsMatch(actual, pattern.ToString()),
            $"expected to find (ignoring line breaks): {expected}");
    }
}

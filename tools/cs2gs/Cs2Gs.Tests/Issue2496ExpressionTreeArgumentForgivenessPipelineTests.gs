// <copyright file="Issue2496ExpressionTreeArgumentForgivenessPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// End-to-end default `--via-sdk` coverage for issue #2496 using an
/// oblivious sibling assembly that exposes EF-style expression-tree sinks.
class Issue2496ExpressionTreeArgumentForgivenessPipelineTests {
    @Fact
    async func Pipeline_ViaSdkDefault_ObliviousExpressionSinks_TranslateAndCompile() {
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
        let result = await pipeline.RunAsync(
            []CorpusApp{CorpusApp("test/ExpressionConsumer", appProject, TargetKind.Library)}
        )
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(appResult.AppId))
        let emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        // ADR-0179 phase 7b: the gsfmt post-pass wraps the two over-wide calls
        // in this chain. What issue #2496 asserts is which arguments carry a
        // `!!`, never where the line breaks, so these match the construct and
        // let the formatter own the layout — see ContainsIgnoringWrap.
        ContainsIgnoringWrap("HasKey((item Item) -> item.Id)", emitted)
        ContainsIgnoringWrap("HasIndex((item Item) -> item.Name)", emitted)
        ContainsIgnoringWrap("HasForeignKey((item Item) ->", emitted)
        ContainsIgnoringWrap("(item Item) -> item.Name!!)", emitted)
        ContainsIgnoringWrap("Selector[Item]((item Item) -> item.Id)", emitted)
        Assert.Contains("OverloadSink.Select", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("item.Id!!", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("item.ParentId!!", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("child.Name!!", emitted, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept all expression-tree sinks. Stages: " + string.Join(
                "; ",
                appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
    }

    shared {
        /// Collapses every run of whitespace to one space.
        private func WriteFixture(sourceRoot string)(ApiProject string, AppProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let apiDir = Path.Combine(sourceRoot, "Api")
            let appDir = Path.Combine(sourceRoot, "ExpressionConsumer")
            Directory.CreateDirectory(apiDir)
            Directory.CreateDirectory(appDir)
            let apiProject = Path.Combine(apiDir, "Api.csproj")
            File.WriteAllText(apiProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(apiDir, "Api.cs"), `using System;
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
}`)
            let appProject = Path.Combine(appDir, "ExpressionConsumer.csproj")
            File.WriteAllText(appProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Api/Api.csproj" />
  </ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(appDir, "Model.cs"), `using ExpressionApi;

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
            Assert.True(process!!.ExitCode == 0, "Failed to prebuild expression sink project:\n" + stdout + stderr)
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2496", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirName string, dllName string) string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, projectDirName, dllName)
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }

        /// ADR-0179 phase 7b: asserts that [`actual`](paramref) contains the
        /// construct [`expected`](paramref) describes, without pinning where
        /// the formatter chose to break lines.
        ///
        /// Write [`expected`](paramref) in its unwrapped form. Whitespace is
        /// tolerated wherever a line break can legally sit — beside a bracket or a
        /// comma — and REQUIRED where the expectation puts it between two ordinary
        /// tokens, because `item Item` and `itemItem` are different programs. A
        /// blunt strip-all-whitespace comparison would accept the second, trading
        /// this test's brittleness for a hole in what it discriminates; the whole
        /// point of these assertions is which arguments carry a `!!`.
        /// @param expected The construct, written unwrapped.
        /// @param actual The emitted G#, raw and unnormalised.
        private func ContainsIgnoringWrap(expected string, actual string) {
            let IsToken = func (c char) bool {
                return char.IsLetterOrDigit(c) || (c == '_' || c == '.' || c == '!' || c == '?')
            }
            let pattern = StringBuilder()
            for var i = 0; i < expected.Length; i++ {
                let c = expected[i]
                if char.IsWhiteSpace(c) {
                    let start = i
                    while i + 1 < expected.Length && char.IsWhiteSpace(expected[i + 1]) {
                        i++
                    }
                    let boundedByTokens = start > 0 &&
                        IsToken(expected[start - 1]) &&
                        i +
                        1 < expected.Length &&
                        IsToken(expected[i + 1])
                    pattern.Append(
                        if boundedByTokens {
                            "\\s+"
                        } else {
                            "\\s*"
                        }
                    )
                    continue
                }
                if c == ')' || c == ']' || c == '}' {
                    pattern.Append("\\s*")
                }
                pattern.Append(Regex.Escape(c.ToString()))
                if c == '(' || c == '[' || c == '{' || c == ',' {
                    pattern.Append("\\s*")
                }
            }
            Assert.True(Regex.IsMatch(actual, pattern.ToString()), "expected to find (ignoring line breaks): $expected")
        }
    }
}

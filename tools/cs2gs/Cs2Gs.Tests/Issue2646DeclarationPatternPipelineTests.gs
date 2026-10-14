// <copyright file="Issue2646DeclarationPatternPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue2646DeclarationPatternPipelineTests {
    @Fact
    async func Pipeline_OahuNullableIntDeclarationPattern_Compiles() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("source")
        let projectPath = Path.Combine(sourceRoot, "Issue2646.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(sourceRoot, "Program.cs"), `namespace Oahu.Cli;

public static class Program
{
    public static int Run(int? rewriteResult)
    {
        try
        {
            var rewriteCode = rewriteResult;
            if (rewriteCode is int code)
            {
                return code;
            }
        }
        catch
        {
        }

        return -1;
    }
}`)
        let outputRoot = NewDirectory("output")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2646", projectPath, TargetKind.Library)})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            string.Join(
                Environment.NewLine,
                app.Artifacts.Select((path string) -> File.ReadAllText(Path.Combine(outputRoot, result.RunId, path)))
            )
        )
        let translated = File.ReadAllText(
            Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.AppId), "Program.gs")
        )
        // ADR-0166 / issue #3409: `rewriteCode is int code` is a native G#
        // pattern variable — no typed hoist, no conversion, no spill.
        Assert.Contains("if rewriteCode is int32 code {", translated, StringComparison.Ordinal)
        Assert.Contains("return code", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("var code int32", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("int32(rewriteCode)", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("let code = rewriteCode", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("return rewriteCode", translated, StringComparison.Ordinal)
    }

    shared {
        private func NewDirectory(category string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2646", category, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func FindSiblingTool(projectDirectoryName string, dllName string) string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(
                        directory.FullName,
                        "out",
                        "bin",
                        configuration,
                        projectDirectoryName,
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

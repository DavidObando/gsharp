// <copyright file="Issue2546MethodGroupPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue2546MethodGroupPipelineTests {
    @Fact
    async func Pipeline_ViaSdk_Cycle4MethodGroups_TranslateAndCompile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        let projectPath = WriteFixture(sourceRoot)
        let outputRoot = NewDirectory("pipeline-tests")
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{CorpusApp("test/Issue2546", projectPath, TargetKind.Library)})
        let app = Assert.Single(result.Apps)
        let emitted = ReadAppOutput(outputRoot, result.RunId, app.AppId)
        Assert.Contains("records.Select(ToDictionary)", emitted, StringComparison.Ordinal)
        Assert.Contains("selected.Where(byAsin.ContainsKey)", emitted, StringComparison.Ordinal)
        Assert.DoesNotContain("selected.Where(func", emitted, StringComparison.Ordinal)
        Assert.Contains("sessions", emitted, StringComparison.Ordinal)
        Assert.Contains(".Count)", emitted, StringComparison.Ordinal)
        Assert.True(
            app.Succeeded,
            "Expected the cycle-4 Oahu method-group call sites to compile. Stages: " + string.Join(
                "; ",
                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
            )
        )
    }

    shared {
        private func WriteFixture(sourceRoot string) string {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let projectDir = Path.Combine(sourceRoot, "Issue2546")
            Directory.CreateDirectory(projectDir)
            let projectPath = Path.Combine(projectDir, "Issue2546.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), `using System.Collections.Generic;
using System.Linq;

namespace Issue2546;

public sealed record Record(string Value);

public static class Repro
{
    public static Dictionary<string, string> ToDictionary(Record record) =>
        new() { ["value"] = record.Value };

    public static int Run(IEnumerable<Record> records)
    {
        var selected = new List<string> { "present", "missing" };
        var byAsin = new Dictionary<string, Record>
        {
            ["present"] = records.Single(),
        };
        var sessions = records.ToList();
        var rows = new List<IReadOnlyDictionary<string, object?>>(sessions.Count);
        System.Func<int> nested = () => records.Select(ToDictionary).Single().Count;
        return nested() + selected.Where(byAsin.ContainsKey).Count() + rows.Capacity;
    }
}`)
            return projectPath
        }

        private func ReadAppOutput(outputRoot string, runId string, appId string) string {
            let directory = Path.Combine(outputRoot, runId, MigrationPipeline.SanitizeAppId(appId))
            return string.Join(
                Environment.NewLine,
                Directory.GetFiles(directory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
            )
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue2546", Guid.NewGuid().ToString("N"))
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

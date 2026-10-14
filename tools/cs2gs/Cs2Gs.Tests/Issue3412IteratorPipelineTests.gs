// <copyright file="Issue3412IteratorPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #3412 iterator source-shape migration coverage.
@Collection("IlVerifyPipeline")
class Issue3412IteratorPipelineTests {
    @Fact
    async func IteratorHelpers_TranslateCompileVerifyAndPreservePartialOwnership() {
        let compiler string? = FindCompiler()
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(
            repoRoot,
            "Release"
        ) == nil ||
            !IlVerifyToolAvailable() {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "Issue3412")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue3412.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Pairs.cs"), `using System.Collections.Generic;

public sealed class Node
{
    public Node(string name)
    {
        Name = name;
    }

    public string Name { get; }
}

public static partial class Helpers
{
    public static IEnumerable<KeyValuePair<string, Node>> Pairs(IEnumerable<Node> nodes)
    {
        foreach (Node node in nodes)
        {
            yield return new KeyValuePair<string, Node>(node.Name, node);
        }
    }
}`)
        File.WriteAllText(Path.Combine(projectDirectory, "Hierarchy.cs"), `using System;
using System.Collections.Generic;

public static partial class Helpers
{
    public static IEnumerable<Type> Hierarchy(Type? current)
    {
        while (current != null)
        {
            yield return current;
            current = current.BaseType;
        }
    }
}`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), `using System;
using System.Collections.Generic;

public static class Program
{
    public static void Main()
    {
        foreach (KeyValuePair<string, Node> pair in Helpers.Pairs(new[] { new Node("a"), new Node("b") }))
        {
            Console.WriteLine(pair.Key);
        }

        foreach (Type type in Helpers.Hierarchy(typeof(List<int>)))
        {
            Console.WriteLine(type.Name);
        }
    }
}`)
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(goldenPath, (`a
b
List` + "`" + `1
Object
`))
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/Issue3412", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot, Config: "Release"},
            []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let translatedFiles = Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories)
        let translated = string.Join(Environment.NewLine, translatedFiles.Select(File.ReadAllText))
        Assert.Equal(
            2,
            translatedFiles.Count(
                (path string) -> File.ReadAllText(path).Contains("partial class Helpers", StringComparison.Ordinal)
            )
        )
        Assert.Contains("sequence[KeyValuePair[string, Node]]", translated, StringComparison.Ordinal)
        Assert.Contains("sequence[Type]", translated, StringComparison.Ordinal)
        Assert.Contains("yield KeyValuePair[string, Node]", translated, StringComparison.Ordinal)
        Assert.Contains("yield current", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("yield current!!", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("List[KeyValuePair[string, Node]]()", translated, StringComparison.Ordinal)
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
        Assert.Equal(
            []string{"passed", "passed", "passed", "passed"},
            appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
        )
    }

    shared {
        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue3412", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
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

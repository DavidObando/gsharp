// <copyright file="Issue3412IteratorPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #3412 iterator source-shape migration coverage.</summary>
[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue3412IteratorPipelineTests
{
    [Fact]
    public async Task IteratorHelpers_TranslateCompileVerifyAndPreservePartialOwnership()
    {
        string compiler = FindCompiler();
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot, "Release") is null
            || !IlVerifyToolAvailable())
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDirectory = Path.Combine(sourceRoot, "Issue3412");
        Directory.CreateDirectory(projectDirectory);
        string projectPath = Path.Combine(projectDirectory, "Issue3412.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Pairs.cs"), """
            using System.Collections.Generic;

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
            }
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Hierarchy.cs"), """
            using System;
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
            }
            """);
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), """
            using System;
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
            }
            """);
        string goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden");
        File.WriteAllText(goldenPath, "a\nb\nList`1\nObject\n");

        string outputRoot = NewDirectory("pipeline-tests");
        var app = new CorpusApp(
            "test/Issue3412",
            projectPath,
            TargetKind.Exe,
            stdoutGolden: goldenPath);
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
                Config = "Release",
            },
            new IMigrationStage[]
            {
                new TranslateStage(),
                new CompileStage(),
                new IlVerifyStage(),
                new TestParityStage(),
            });

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        string appDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(app.Id));
        string[] translatedFiles = Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories);
        string translated = string.Join(Environment.NewLine, translatedFiles.Select(File.ReadAllText));

        Assert.Equal(
            2,
            translatedFiles.Count(path =>
                File.ReadAllText(path).Contains("partial class Helpers", StringComparison.Ordinal)));
        Assert.Contains("sequence[KeyValuePair[string, Node]]", translated, StringComparison.Ordinal);
        Assert.Contains("sequence[Type]", translated, StringComparison.Ordinal);
        Assert.Contains("yield KeyValuePair[string, Node]", translated, StringComparison.Ordinal);
        Assert.Contains("yield current", translated, StringComparison.Ordinal);
        Assert.DoesNotContain("yield current!!", translated, StringComparison.Ordinal);
        Assert.DoesNotContain("List[KeyValuePair[string, Node]]()", translated, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
        Assert.Equal(
            new[] { "passed", "passed", "passed", "passed" },
            appResult.Stages.Select(stage => stage.Status).ToArray());
    }

    private static bool IlVerifyToolAvailable()
    {
        try
        {
            return !IlVerifyRunner.IsEnabled || new IlVerifyRunner().EnsureToolAvailable();
        }
        catch
        {
            return false;
        }
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue3412",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
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
                    "Compiler",
                    "gsc.dll");
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

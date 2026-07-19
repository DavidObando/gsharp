// <copyright file="Issue2514ImportedInterfaceConstraintPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Default SDK-backed regression for imported constraint properties.</summary>
public sealed class Issue2514ImportedInterfaceConstraintPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_ImportedConstraintReadsWritesAndCalls_Compile()
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
        (string contractsProject, string consumerProject) = WriteFixture(sourceRoot);
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
        RunResult result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/Contracts", contractsProject, TargetKind.Library),
            new CorpusApp("test/Consumer", consumerProject, TargetKind.Library),
        });

        Assert.All(
            result.Apps,
            app => Assert.True(
                app.Succeeded,
                app.AppId + " should compile through default --via-sdk/gsc. Stages: "
                    + string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status))));

        AppResult consumer = result.Apps.Single(app => app.AppId == "test/Consumer");
        string runDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(consumer.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("func Read[T IPerson](value T) string -> value.Name", emitted, StringComparison.Ordinal);
        Assert.Contains("value.Name = name", emitted, StringComparison.Ordinal);
        Assert.Contains("value.Books.Add(book)", emitted, StringComparison.Ordinal);
    }

    private static (string ContractsProject, string ConsumerProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string contractsDirectory = Path.Combine(sourceRoot, "Contracts");
        Directory.CreateDirectory(contractsDirectory);
        string contractsProject = Path.Combine(contractsDirectory, "Contracts.csproj");
        File.WriteAllText(contractsProject, ProjectFile(null));
        File.WriteAllText(Path.Combine(contractsDirectory, "Contracts.cs"), """
            using System.Collections.Generic;

            namespace Issue2514.Contracts;

            public interface IPerson
            {
                string Name { get; set; }
                IList<string> Books { get; }
            }

            public sealed class Author : IPerson
            {
                public string Name { get; set; } = "Ada";
                public IList<string> Books { get; } = new List<string>();
            }
            """);

        string consumerDirectory = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(consumerDirectory);
        string consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj");
        File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"));
        File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), """
            using Issue2514.Contracts;

            namespace Issue2514.Consumer;

            public static class Repro
            {
                public static string Read<T>(T value) where T : IPerson => value.Name;

                public static void Write<T>(T value, string name, string book) where T : IPerson
                {
                    value.Name = name;
                    value.Books.Add(book);
                }

                public static string Test(Author value) => Read(value);
            }
            """);

        return (contractsProject, consumerProject);
    }

    private static string ProjectFile(string projectReference)
    {
        string reference = projectReference is null
            ? string.Empty
            : $"""

                <ItemGroup>
                  <ProjectReference Include="{projectReference}" />
                </ItemGroup>
              """;
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>{reference}
            </Project>
            """;
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2514",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirectoryName, string dllName)
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
                    projectDirectoryName,
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

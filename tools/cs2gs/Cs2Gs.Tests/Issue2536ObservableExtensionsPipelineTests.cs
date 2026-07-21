// <copyright file="Issue2536ObservableExtensionsPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2536ObservableExtensionsPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_ObservableAndInheritedInterfaceLinqExtensions_Compile()
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

            namespace Issue2536.Contracts;

            public sealed class Model
            {
                public int Value { get; set; }
            }

            public interface IModels : IReadOnlyCollection<Model>
            {
            }
            """);

        string consumerDirectory = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(consumerDirectory);
        string consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj");
        File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"));
        File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), """
            using System.Collections.Generic;
            using System.Collections.ObjectModel;
            using System.Linq;
            using Issue2536.Contracts;

            namespace Issue2536.Consumer;

            public static class Repro
            {
                public static IEnumerable<Model> Where(ObservableCollection<Model> items) =>
                    items.Where(item => item.Value > 0);

                public static bool Any(IModels items) =>
                    items.Any(item => item.Value > 0);

                public static int Count(ObservableCollection<Model> items) =>
                    items.Count(item => item.Value > 0);

                public static Model? FirstOrDefault(IModels items) =>
                    items.FirstOrDefault();
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
                <Nullable>enable</Nullable>
              </PropertyGroup>{reference}
            </Project>
            """;
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2536",
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

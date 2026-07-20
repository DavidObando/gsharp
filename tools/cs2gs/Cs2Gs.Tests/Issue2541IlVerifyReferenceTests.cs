// <copyright file="Issue2541IlVerifyReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Regression coverage for ILVerify reference resolution in multi-project migrations.</summary>
public sealed class Issue2541IlVerifyReferenceTests
{
    [Fact]
    public async Task Pipeline_SafeProjectReference_PassesIlVerify()
    {
        string compiler = FindCompiler();
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null
            || !IlVerifyToolAvailable())
        {
            return;
        }

        string sourceRoot = NewDirectory("scratch-projects");
        (string contractsProject, string consumerProject) = WriteFixture(sourceRoot);
        string outputRoot = NewDirectory("pipeline-tests");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage(), new IlVerifyStage() });

        RunResult result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/Contracts", contractsProject, TargetKind.Library),
            new CorpusApp("test/Consumer", consumerProject, TargetKind.Library),
        });

        Assert.All(
            result.Apps,
            app => Assert.True(
                app.Succeeded,
                app.AppId + " should pass ILVerify. Stages: " +
                    string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status))));
        Assert.All(result.Apps, app => Assert.Equal("passed", app.Stages[2].Status));
    }

    private static (string ContractsProject, string ConsumerProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string contractsDir = Path.Combine(sourceRoot, "Contracts");
        Directory.CreateDirectory(contractsDir);
        string contractsProject = Path.Combine(contractsDir, "Contracts.csproj");
        File.WriteAllText(contractsProject, ProjectFile(null));
        File.WriteAllText(Path.Combine(contractsDir, "Greeter.cs"), """
            namespace Contracts;

            public sealed class Greeter
            {
                public string Greet(string name) => "Hello, " + name;
            }
            """);

        string consumerDir = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(consumerDir);
        string consumerProject = Path.Combine(consumerDir, "Consumer.csproj");
        File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"));
        File.WriteAllText(Path.Combine(consumerDir, "Welcome.cs"), """
            using Contracts;

            namespace Consumer;

            public static class Welcome
            {
                public static string Message(string name) => new Greeter().Greet(name);
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
            "issue2541",
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

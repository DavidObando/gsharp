// <copyright file="Issue2509ConstraintTypeQualificationPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Default SDK-backed/gsc sink coverage for issue #2509's cross-project
/// constraint collision and a negative control proving constraint enforcement
/// remains active.
/// </summary>
public sealed class Issue2509ConstraintTypeQualificationPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_CrossProjectConstraintCollision_TranslatesAndCompiles()
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
                app.AppId + " should compile through default --via-sdk/gsc. Stages: " +
                    string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status))));

        AppResult consumer = result.Apps.Single(app => app.AppId == "test/Consumer");
        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(consumer.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("func Add[T A.IPerson class init()]() T", emitted, StringComparison.Ordinal);
        Assert.Contains("func Test() Author -> Add[Author]()", emitted, StringComparison.Ordinal);
    }

    [Fact]
    public void ViaSdk_GenuinelyUnsatisfiedConstraint_StillReportsGs0152()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (repoRoot is null || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        string workDir = NewDirectory("negative-control");
        string sourcePath = Path.Combine(workDir, "Negative.gs");
        File.WriteAllText(sourcePath, """
            package Negative

            interface IContract {
            }

            class Wrong {
            }

            class Repro {
                shared {
                    func Add[T IContract]() {
                    }

                    func Test() -> Add[Wrong]()
                }
            }
            """);

        SdkCompileResult result = new SdkCompileRunner().Compile(
            workDir,
            "Negative",
            new[] { sourcePath },
            TargetKind.Library,
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            rootNamespace: null,
            config: "Release");

        Assert.True(result.IsAvailable, result.UnavailableReason);
        Assert.False(result.Succeeded);
        Assert.Contains(result.Errors, diagnostic => diagnostic.Id == "GS0152");
    }

    private static (string ContractsProject, string ConsumerProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string contractsDir = Path.Combine(sourceRoot, "Contracts");
        Directory.CreateDirectory(contractsDir);
        string contractsProject = Path.Combine(contractsDir, "Contracts.csproj");
        File.WriteAllText(contractsProject, ProjectFile(null));
        File.WriteAllText(Path.Combine(contractsDir, "Contracts.cs"), """
            namespace A;

            public interface IPerson { }

            public sealed class Author : IPerson
            {
            }
            """);

        string consumerDir = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(consumerDir);
        string consumerProject = Path.Combine(consumerDir, "Consumer.csproj");
        File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"));
        File.WriteAllText(Path.Combine(consumerDir, "Repro.cs"), """
            using A;

            namespace B
            {
                public interface IPerson { }
            }

            namespace App
            {
                public static class Repro
                {
                    public static T Add<T>() where T : class, IPerson, new() => new T();
                    public static B.IPerson GetOther() => null;
                    public static Author Test() => Add<Author>();
                }
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
            "issue2509",
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
}

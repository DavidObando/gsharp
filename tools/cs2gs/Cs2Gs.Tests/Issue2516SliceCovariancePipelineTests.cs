// <copyright file="Issue2516SliceCovariancePipelineTests.cs" company="GSharp">
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
/// Default <c>--via-sdk</c>/gsc regression for issue #2516's exact stable
/// minimal two-project repro (a referenced <c>Probe</c> project declaring
/// <c>IPerson</c>/<c>Author</c>, and a <c>Consumer</c> project passing an
/// <c>Author[]</c> where <c>IEnumerable&lt;IPerson&gt;?</c> is expected) plus the
/// Oahu <c>product.Authors -&gt; IEnumerable&lt;IPerson&gt;</c> shape (a nullable
/// covariant argument read off a property, mirroring
/// <c>BookLibrary.AddPersons(..., product.Authors, ...)</c>).
/// </summary>
public sealed class Issue2516SliceCovariancePipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_StableMinimalRepro_TranslatesAndCompiles()
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
        (string probeProject, string consumerProject) = WriteStableMinimalReproFixture(sourceRoot);
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
            new CorpusApp("test/Probe", probeProject, TargetKind.Library),
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

        // Compiler-level slice/interface covariance makes the natural
        // translation valid; cs2gs must not manufacture an `as` escape hatch.
        Assert.Contains("Repro.Accept(values)", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("values as IEnumerable[IPerson]", emitted, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Pipeline_ViaSdkDefault_OahuAuthorsShape_TranslatesAndCompiles()
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
        string projectPath = WriteOahuShapeFixture(sourceRoot);
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
            new[] { new CorpusApp("test/OahuShape", projectPath, TargetKind.Library) });
        AppResult appResult = Assert.Single(result.Apps);

        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(appResult.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("product.Authors", emitted, StringComparison.Ordinal);
        Assert.DoesNotContain("product.Authors as", emitted, StringComparison.Ordinal);
        Assert.True(
            appResult.Succeeded,
            "Expected default --via-sdk/gsc compilation to accept the Oahu product.Authors -> IEnumerable<IPerson> shape. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
    }

    [Fact]
    public async Task Pipeline_ViaSdkDefault_CompilerCovarianceCoversFormerSinkWorkarounds()
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
        string projectPath = WriteCompilerCovarianceSinkFixture(sourceRoot);
        string outputRoot = NewDirectory("pipeline-tests");
        var pipeline = new MigrationPipeline(
            new PipelineOptions
            {
                GscPath = compiler,
                OutputRoot = outputRoot,
                SourceRoot = sourceRoot,
            },
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(
            new[] { new CorpusApp("test/CompilerCovarianceSinks", projectPath, TargetKind.Library) });
        AppResult appResult = Assert.Single(result.Apps);
        Assert.True(
            appResult.Succeeded,
            "Expected compiler covariance to cover folded static initialization, constructor lifting, " +
                "typed foreach, and expression-tree result conversion. Stages: " +
                string.Join("; ", appResult.Stages.Select(stage => stage.Stage + "=" + stage.Status)));

        string appRunDir = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(appResult.AppId));
        string emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appRunDir, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));
        Assert.DoesNotContain(" as IEnumerable[IPerson]", emitted, StringComparison.Ordinal);
    }

    private static (string ProbeProject, string ConsumerProject) WriteStableMinimalReproFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string probeDirectory = Path.Combine(sourceRoot, "Probe");
        Directory.CreateDirectory(probeDirectory);
        string probeProject = Path.Combine(probeDirectory, "Probe.csproj");
        File.WriteAllText(probeProject, ProjectFile(null, nullable: true));
        File.WriteAllText(Path.Combine(probeDirectory, "Probe.cs"), """
            namespace Probe;
            public interface IPerson { }
            public sealed class Author : IPerson { }
            """);

        string consumerDirectory = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(consumerDirectory);
        string consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj");
        File.WriteAllText(consumerProject, ProjectFile("../Probe/Probe.csproj", nullable: true));
        File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), """
            using System.Collections.Generic;
            using Probe;

            namespace Consumer;

            public static class Repro
            {
                public static void Accept(IEnumerable<IPerson>? values) { }
                public static void Test(Author[] values) => Accept(values);
            }
            """);

        return (probeProject, consumerProject);
    }

    private static string WriteOahuShapeFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "OahuShape");
        Directory.CreateDirectory(projectDir);

        string projectPath = Path.Combine(projectDir, "OahuShape.csproj");
        File.WriteAllText(projectPath, ProjectFile(null, nullable: false));
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), """
            using System.Collections.Generic;

            namespace OahuShape.Json
            {
                public interface IPerson { }

                public sealed class Author : IPerson
                {
                }
            }

            namespace OahuShape.Models
            {
                using OahuShape.Json;

                public sealed class Product
                {
                    public Author[] Authors { get; set; } = new Author[0];
                }
            }

            namespace OahuShape
            {
                using OahuShape.Json;
                using OahuShape.Models;

                public static class BookLibrary
                {
                    private static void AddPersons<TPerson>(
                        string label,
                        IEnumerable<IPerson> itmPersons,
                        int depth)
                    {
                    }

                    public static void AddAuthors(Product product)
                    {
                        AddPersons<Author>("authors", product.Authors, 0);
                    }
                }
            }
            """);

        return projectPath;
    }

    private static string WriteCompilerCovarianceSinkFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");
        string projectDir = Path.Combine(sourceRoot, "CompilerCovarianceSinks");
        Directory.CreateDirectory(projectDir);

        string projectPath = Path.Combine(projectDir, "CompilerCovarianceSinks.csproj");
        File.WriteAllText(projectPath, ProjectFile(null, nullable: false));
        File.WriteAllText(Path.Combine(projectDir, "Repro.cs"), """
            using System;
            using System.Collections.Generic;
            using System.Linq.Expressions;

            namespace CompilerCovarianceSinks;

            public interface IPerson { }
            public sealed class Author : IPerson { }

            public sealed class Holder
            {
                public readonly IEnumerable<IPerson> People;

                public Holder(Author[] people)
                {
                    People = people;
                }
            }

            public static class Repro
            {
                public static readonly IEnumerable<IPerson> StaticPeople;

                static Repro()
                {
                    StaticPeople = new Author[0];
                }

                public static void Accept(IEnumerable<IPerson> people) { }

                public static Holder Create(Author[] people) => new Holder(people);

                public static void Visit(IEnumerable<Author[]> groups)
                {
                    foreach (IEnumerable<IPerson> group in groups)
                    {
                        Accept(group);
                    }
                }

                public static Expression<Func<Author[], IEnumerable<IPerson>>> Tree() =>
                    people => people;
            }
            """);

        return projectPath;
    }

    private static string ProjectFile(string projectReference, bool nullable)
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
                <Nullable>{(nullable ? "enable" : "disable")}</Nullable>
              </PropertyGroup>{reference}
            </Project>
            """;
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2516",
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

// <copyright file="Issue2521ImportedInitializerTargetContractPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Default <c>--via-sdk</c>/gsc coverage for issue #2521 across a prebuilt,
/// multi-level project-reference graph.
/// </summary>
public sealed class Issue2521ImportedInitializerTargetContractPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_ImportedInitializerSinks_CompileDeterministically()
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
        Fixture fixture = WriteFixture(sourceRoot);

        // Prebuild the middle project so both it and the leaf target assembly
        // exist on disk before MSBuildWorkspace loads the consumer.
        RunDotnetBuild(fixture.BridgeProject);

        string outputRoot = NewDirectory("pipeline-tests");
        RunResult first = await RunPipeline(outputRoot, sourceRoot, compiler, fixture);
        string firstConsumer = AssertSuccessfulAndRead(
            first,
            outputRoot,
            "test/Consumer",
            "Consumer.cs");
        string firstEnabled = AssertSuccessfulAndRead(
            first,
            outputRoot,
            "test/EnabledConsumer",
            "EnabledConsumer.cs");
        AssertExpectedSinks(firstConsumer, firstEnabled);

        RunResult second = await RunPipeline(outputRoot, sourceRoot, compiler, fixture);
        string secondConsumer = AssertSuccessfulAndRead(
            second,
            outputRoot,
            "test/Consumer",
            "Consumer.cs");
        string secondEnabled = AssertSuccessfulAndRead(
            second,
            outputRoot,
            "test/EnabledConsumer",
            "EnabledConsumer.cs");

        Assert.Equal(Compact(firstConsumer), Compact(secondConsumer));
        Assert.Equal(Compact(firstEnabled), Compact(secondEnabled));
        AssertExpectedSinks(secondConsumer, secondEnabled);
    }

    private static async Task<RunResult> RunPipeline(
        string outputRoot,
        string sourceRoot,
        string compiler,
        Fixture fixture)
    {
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
        return await pipeline.RunAsync(
            new[]
            {
                new CorpusApp("test/Target", fixture.TargetProject, TargetKind.Library),
                new CorpusApp("test/Bridge", fixture.BridgeProject, TargetKind.Library),
                new CorpusApp("test/Consumer", fixture.ConsumerProject, TargetKind.Library),
                new CorpusApp("test/EnabledConsumer", fixture.EnabledConsumerProject, TargetKind.Library),
            });
    }

    private static void AssertExpectedSinks(string consumer, string enabledConsumer)
    {
        string compact = Compact(consumer);
        Assert.Contains(
            "Target{Value: source.Value!!, InitValue: source.Value!!, Field: source.Value!!}",
            compact);
        Assert.Contains("Target(1){Value = source.Value!!}", compact);
        Assert.Contains("Nested: Target{Value: source.Value!!}", compact);
        Assert.Contains("T{Value: source.Value!!}", compact);
        Assert.Contains("List[string]{ source.Value!! }", compact);
        Assert.Contains("Holder{Values: { source.Value!! }}", compact);
        Assert.Contains("Holder(1){Values = { source.Value!! }}", compact);
        Assert.Contains("\"key\": source.Value!!", compact);
        Assert.Contains("[\"key\"] = source.Value!!", compact);
        Assert.Contains("Target{Value: value!!}", compact);

        Assert.Contains("LocalTarget{Value: source.Value}", compact);
        Assert.DoesNotContain("LocalTarget{Value: source.Value!!}", compact);
        Assert.Contains("NullableTarget{Value: source.Value}", compact);
        Assert.DoesNotContain("NullableTarget{Value: source.Value!!}", compact);

        string enabledCompact = Compact(enabledConsumer);
        Assert.Contains("Target{Value: source.Value!!}", enabledCompact);
        Assert.Contains("NullableTarget{Value: source.Value}", enabledCompact);
    }

    private static Fixture WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string targetDir = Path.Combine(sourceRoot, "Target");
        string bridgeDir = Path.Combine(sourceRoot, "Bridge");
        string consumerDir = Path.Combine(sourceRoot, "Consumer");
        string enabledDir = Path.Combine(sourceRoot, "EnabledConsumer");
        Directory.CreateDirectory(targetDir);
        Directory.CreateDirectory(bridgeDir);
        Directory.CreateDirectory(consumerDir);
        Directory.CreateDirectory(enabledDir);

        string targetProject = Path.Combine(targetDir, "Target.csproj");
        File.WriteAllText(targetProject, ProjectFile(nullable: "disable"));
        File.WriteAllText(Path.Combine(targetDir, "Target.cs"), """
            #nullable disable
            namespace Imported;

            public interface ITarget
            {
                string Value { get; set; }
            }

            public sealed class Target : ITarget
            {
                public Target() { }

                public Target(int id) { }

                public string Value { get; set; }

                public string InitValue { get; init; }

                public string Field;
            }

            public sealed class Holder
            {
                public Holder() { }

                public Holder(int id) { }

                public System.Collections.Generic.List<string> Values { get; } = new();
            }

            #nullable enable
            public sealed class NullableTarget
            {
                public string? Value { get; set; }
            }
            """);

        string bridgeProject = Path.Combine(bridgeDir, "Bridge.csproj");
        File.WriteAllText(
            bridgeProject,
            ProjectFile(nullable: "disable", "../Target/Target.csproj"));
        File.WriteAllText(Path.Combine(bridgeDir, "Bridge.cs"), """
            using Imported;

            namespace Bridge;

            public sealed class TargetFactory
            {
                public Target Create() => new Target();
            }
            """);

        string consumerProject = Path.Combine(consumerDir, "Consumer.csproj");
        File.WriteAllText(
            consumerProject,
            ProjectFile(
                nullable: "disable",
                "../Bridge/Bridge.csproj",
                "../Target/Target.csproj"));
        File.WriteAllText(Path.Combine(consumerDir, "Consumer.cs"), """
            #nullable disable
            using System.Collections.Generic;
            using Imported;

            namespace Consumer;

            public interface ISource
            {
                string Value { get; set; }
            }

            public sealed class Wrapper
            {
                public Target Nested { get; set; }
            }

            public sealed class LocalTarget
            {
                public string Value { get; set; }

                public bool HasValue => Value is not null;
            }

            public static class Repro
            {
                public static bool SourceMayBeNull(ISource source) => source.Value is null;

                public static Target Property(ISource source) =>
                    new Target
                    {
                        Value = source.Value,
                        InitValue = source.Value,
                        Field = source.Value,
                    };

                public static Target ConstructorSuffix(ISource source) =>
                    new Target(1) { Value = source.Value };

                public static Wrapper Nested(ISource source) =>
                    new Wrapper { Nested = new Target { Value = source.Value } };

                public static T GenericConstraint<T>(ISource source)
                    where T : class, ITarget, new() =>
                    new T { Value = source.Value };

                public static List<string> BareAdd(ISource source) =>
                    new List<string> { source.Value };

                public static Holder NestedCollection(ISource source) =>
                    new Holder { Values = { source.Value } };

                public static Holder SuffixNestedCollection(ISource source) =>
                    new Holder(1) { Values = { source.Value } };

                public static Dictionary<string, string> KeyedAdd(ISource source) =>
                    new Dictionary<string, string> { { "key", source.Value } };

                public static Dictionary<string, string> Indexed(ISource source) =>
                    new Dictionary<string, string> { ["key"] = source.Value };

                public static Target Parameter(string value)
                {
                    if (value is null)
                        value = "fallback";

                    return new Target { Value = value };
                }

                public static Target Local(ISource source)
                {
                    string value = source.Value;
                    if (value is null)
                        value = "fallback";

                    return new Target { Value = value };
                }

                public static LocalTarget SameCompilationTarget(ISource source) =>
                    new LocalTarget { Value = source.Value };

                public static NullableTarget ReferencedNullableTarget(ISource source) =>
                    new NullableTarget { Value = source.Value };
            }
            """);

        string enabledConsumerProject = Path.Combine(enabledDir, "EnabledConsumer.csproj");
        File.WriteAllText(
            enabledConsumerProject,
            ProjectFile(
                nullable: "enable",
                "../Bridge/Bridge.csproj",
                "../Target/Target.csproj"));
        File.WriteAllText(Path.Combine(enabledDir, "EnabledConsumer.cs"), """
            using Imported;

            namespace EnabledConsumer;

            public interface ISource
            {
                string? Value { get; }
            }

            public static class Repro
            {
                public static Target Create(ISource source) =>
                    new Target { Value = source.Value! };

                public static NullableTarget CreateNullable(ISource source) =>
                    new NullableTarget { Value = source.Value };
            }
            """);

        return new Fixture(
            targetProject,
            bridgeProject,
            consumerProject,
            enabledConsumerProject);
    }

    private static string ProjectFile(string nullable, params string[] projectReferences)
    {
        string itemGroup = projectReferences.Length == 0
            ? string.Empty
            : $"""
                <ItemGroup>
                {string.Join(
                    Environment.NewLine,
                    projectReferences.Select(reference => $"  <ProjectReference Include=\"{reference}\" />"))}
                </ItemGroup>
              """;
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>{nullable}</Nullable>
              </PropertyGroup>
              {itemGroup}
            </Project>
            """;
    }

    private static string AssertSuccessfulAndRead(
        RunResult result,
        string outputRoot,
        string appId,
        string fileName)
    {
        AppResult app = result.Apps.Single(candidate => candidate.AppId == appId);
        Assert.True(
            app.Succeeded,
            $"Expected default --via-sdk/gsc compilation to succeed for {appId}. Stages: " +
                string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));

        string appDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(appId));
        string[] matches = Directory.GetFiles(
            appDirectory,
            fileName.Replace(".cs", ".gs", StringComparison.Ordinal),
            SearchOption.AllDirectories);
        Assert.Single(matches);
        return File.ReadAllText(matches[0]);
    }

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo(
            "dotnet",
            $"build \"{projectPath}\" --nologo --verbosity:quiet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.Environment["MSBUILDDISABLENODEREUSE"] = "1";

        using Process process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(
            process.ExitCode == 0,
            "Failed to prebuild multi-level fixture:\n" + stdout + stderr);
    }

    private static string NewDirectory(string category)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2521",
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

    private static string Compact(string printed) =>
        string.Join(
            " ",
            printed.Split(
                new[] { ' ', '\t', '\r', '\n' },
                StringSplitOptions.RemoveEmptyEntries));

    private sealed record Fixture(
        string TargetProject,
        string BridgeProject,
        string ConsumerProject,
        string EnabledConsumerProject);
}

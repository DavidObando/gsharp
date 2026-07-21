// <copyright file="Issue2525ImportedIndexerHidingPipelineTests.cs" company="GSharp">
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
/// Default <c>--via-sdk</c> coverage for imported interface indexer hiding,
/// including the ASP.NET Core <c>IHeaderDictionary</c> shape from issue #2525.
/// </summary>
public sealed class Issue2525ImportedIndexerHidingPipelineTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_DerivedAndHeaderIndexers_Compile()
    {
        var compiler = FindSiblingTool("Compiler", "gsc.dll");
        var repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null
            || repoRoot is null
            || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            return;
        }

        var sourceRoot = NewDirectory("scratch-projects");
        var fixture = WriteFixture(sourceRoot);
        RunDotnetBuild(fixture.ConsumerProject);

        var outputRoot = NewDirectory("pipeline-tests");
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
        var result = await pipeline.RunAsync(new[]
        {
            new CorpusApp("test/Contracts", fixture.ContractsProject, TargetKind.Library),
            new CorpusApp("test/Consumer", fixture.ConsumerProject, TargetKind.Library),
        });

        Assert.All(
            result.Apps,
            app => Assert.True(
                app.Succeeded,
                app.AppId + " should compile through default --via-sdk/gsc. Stages: "
                    + string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status))));

        var consumer = result.Apps.Single(app => app.AppId == "test/Consumer");
        var runDirectory = Path.Combine(
            outputRoot,
            result.RunId,
            MigrationPipeline.SanitizeAppId(consumer.AppId));
        var emitted = string.Join(
            Environment.NewLine,
            Directory.GetFiles(runDirectory, "*.gs", SearchOption.AllDirectories)
                .Select(File.ReadAllText));

        Assert.Contains("value[\"key\"]", emitted, StringComparison.Ordinal);
        Assert.Contains("value[key] = replacement", emitted, StringComparison.Ordinal);
        Assert.Contains("func ReadConstrained[T IDerived]", emitted, StringComparison.Ordinal);
        Assert.Contains("value[\"key\"] += \"!\"", emitted, StringComparison.Ordinal);
        Assert.Contains("value?[\"key\"]", emitted, StringComparison.Ordinal);
        Assert.Contains("Values: { [\"key\"] = \"nested\" }", Compact(emitted), StringComparison.Ordinal);
        Assert.Contains("ctx.Request.Headers[\"Authorization\"]", emitted, StringComparison.Ordinal);
        Assert.Contains("ctx.Response.Headers[\"Retry-After\"] = \"1\"", emitted, StringComparison.Ordinal);
    }

    private static Fixture WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        var contractsDirectory = Path.Combine(sourceRoot, "Contracts");
        Directory.CreateDirectory(contractsDirectory);
        var contractsProject = Path.Combine(contractsDirectory, "Contracts.csproj");
        File.WriteAllText(contractsProject, ProjectFile());
        File.WriteAllText(Path.Combine(contractsDirectory, "Contracts.cs"), """
            namespace Issue2525.Contracts;

            public interface IBase
            {
                string this[string key] { get; set; }
            }

            public interface IDerived : IBase
            {
                new string this[string key] { get; set; }
            }

            public interface IGenericBase<T>
            {
                T this[T key] { get; set; }
            }

            public interface IGenericDerived<T> : IGenericBase<T>
            {
                new T this[T key] { get; set; }
            }

            public interface IDiamondRoot
            {
                string this[string key] { get; set; }
            }

            public interface IDiamondLeft : IDiamondRoot
            {
                new string this[string key] { get; set; }
            }

            public interface IDiamondRight : IDiamondRoot
            {
            }

            public interface IDiamondLeaf : IDiamondLeft, IDiamondRight
            {
                new string this[string key] { get; set; }
            }
            """);

        var consumerDirectory = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(consumerDirectory);
        var consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj");
        File.WriteAllText(
            consumerProject,
            ProjectFile("../Contracts/Contracts.csproj", includeAspNetCore: true));
        File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), """
            using Issue2525.Contracts;
            using Microsoft.AspNetCore.Http;

            namespace Issue2525.Consumer;

            public sealed class Holder
            {
                public IDerived Values { get; } = CreateValues();

                private static IDerived CreateValues() =>
                    throw new System.InvalidOperationException();
            }

            public static class Repro
            {
                public static string Read(IDerived value) => value["key"];

                public static void Write(IDerived value, string key, string replacement) =>
                    value[key] = replacement;

                public static string ReadBase(IDerived value) => ((IBase)value)["key"];

                public static T ReadGeneric<T>(IGenericDerived<T> value, T key) => value[key];

                public static string ReadConstrained<T>(T value)
                    where T : IDerived =>
                    value["key"];

                public static string ReadDiamond(IDiamondLeaf value) => value["key"];

                public static string Compound(IDerived value)
                {
                    value["key"] += "!";
                    return value["key"];
                }

                public static string? Conditional(IDerived? value) => value?["key"];

                public static Holder NestedInitializer() =>
                    new Holder { Values = { ["key"] = "nested" } };

                public static string HeaderRead(HttpContext ctx) =>
                    ctx.Request.Headers["Authorization"].ToString();

                public static void HeaderWrite(HttpContext ctx) =>
                    ctx.Response.Headers["Retry-After"] = "1";
            }
            """);

        return new Fixture(contractsProject, consumerProject);
    }

    private static string ProjectFile(
        string projectReference = null,
        bool includeAspNetCore = false)
    {
        var references = projectReference is null
            ? string.Empty
            : $"""

                <ItemGroup>
                  <ProjectReference Include="{projectReference}" />
                </ItemGroup>
              """;
        var framework = includeAspNetCore
            ? """

                <ItemGroup>
                  <FrameworkReference Include="Microsoft.AspNetCore.App" />
                </ItemGroup>
              """
            : string.Empty;
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>{references}{framework}
            </Project>
            """;
    }

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(projectPath)!,
        };
        startInfo.ArgumentList.Add("build");
        startInfo.ArgumentList.Add(projectPath);
        startInfo.ArgumentList.Add("--nologo");
        startInfo.ArgumentList.Add("--verbosity:quiet");

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet build.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(120_000), "dotnet build timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet build failed ({process.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static string Compact(string value) =>
        string.Join(
            " ",
            value.Split((char[])null, StringSplitOptions.RemoveEmptyEntries));

    private static string NewDirectory(string category)
    {
        var root = Path.Combine(
            AppContext.BaseDirectory,
            category,
            "issue2525",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirectoryName, string dllName)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (var configuration in new[] { "Release", "Debug" })
            {
                var candidate = Path.Combine(
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

    private sealed record Fixture(string ContractsProject, string ConsumerProject);
}

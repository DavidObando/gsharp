// <copyright file="Issue2523NullableImportedGenericBaseConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Runtime, reflection, C# consumer, and ILVerify coverage for issue #2523.
/// </summary>
public sealed class Issue2523NullableImportedGenericBaseConversionEmitTests
{
    [Fact]
    public void ImportedGenericReturnBaseConversionsRunAndPreserveMetadata()
    {
        var directory = NewDirectory();
        try
        {
            var fixturePath = Path.Combine(directory, "Issue2523.Metadata.dll");
            EmitFixture(fixturePath);

            const string source = """
                package Issue2523.Emit
                import System
                import Issue2523.Metadata

                class Api2523 {
                    shared {
                        func Build(
                            source IQuery2523[MetadataEntity2523])
                            IQuery2523[MetadataEntity2523] ->
                            QueryExtensions2523.Include2523(
                                source,
                                    (entity MetadataEntity2523) -> entity.Child)
                                .Include2523(
                                    (entity MetadataEntity2523) -> entity.Other)

                        func BuildChain(
                            source IQuery2523[MetadataEntity2523])
                            IChain2523[
                                MetadataEntity2523,
                                MetadataChild2523?,
                                string,
                                string] ->
                            QueryExtensions2523.Include2523(
                                source,
                                (entity MetadataEntity2523) -> entity.Child)
                    }
                }

                func Main() {
                    let source = Query2523[MetadataEntity2523](1)
                    Console.WriteLine(Api2523.Build(source).Count)
                    Console.WriteLine(Api2523.BuildChain(source).Count)
                }
                """;

            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "Issue2523.Emit.dll");
            File.WriteAllText(sourcePath, source);
            var (exitCode, output) = Compile(sourcePath, outputPath, fixturePath);
            Assert.True(exitCode == 0, output);

            var references = TrustedPlatformAssemblies().Append(fixturePath).ToArray();
            IlVerifier.Verify(outputPath, additionalReferences: references);
            Assert.Equal("3\n2\n", Run(outputPath));

            var fixture = Assembly.LoadFrom(fixturePath);
            var emitted = Assembly.LoadFrom(outputPath);
            var api = emitted.GetType("Issue2523.Emit.Api2523", throwOnError: true)!;
            var buildChain = api.GetMethod(
                "BuildChain",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
            var nullability = new NullabilityInfoContext().Create(buildChain.ReturnParameter);
            Assert.Equal(NullabilityState.Nullable, nullability.GenericTypeArguments[1].ReadState);

            const string consumerSource = """
                #nullable enable
                using Issue2523.Emit;
                using Issue2523.Metadata;

                public static class Consumer2523
                {
                    public static IQuery2523<MetadataEntity2523> Build()
                    {
                        var source = new Query2523<MetadataEntity2523>(1);
                        IChain2523<
                            MetadataEntity2523,
                            MetadataChild2523?,
                            string,
                            string> chain = Api2523.BuildChain(source);
                        return chain;
                    }
                }
                """;
            var consumer = CSharpCompilation.Create(
                "Issue2523.Consumer",
                new[] { CSharpSyntaxTree.ParseText(consumerSource) },
                TrustedPlatformAssemblies()
                    .Select(path => MetadataReference.CreateFromFile(path))
                    .Append(MetadataReference.CreateFromFile(fixturePath))
                    .Append(MetadataReference.CreateFromFile(outputPath)),
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable,
                    generalDiagnosticOption: ReportDiagnostic.Error));
            using var consumerPe = new MemoryStream();
            var consumerResult = consumer.Emit(consumerPe);
            Assert.True(
                consumerResult.Success,
                string.Join(Environment.NewLine, consumerResult.Diagnostics));

            GC.KeepAlive(fixture);
        }
        finally
        {
            TryDelete(directory);
        }
    }

    private static void EmitFixture(string outputPath)
    {
        const string fixtureSource = """
            #nullable enable
            using System;
            using System.Linq.Expressions;

            namespace Issue2523.Metadata;

            public interface IQuery2523<out TEntity>
            {
                int Count { get; }
            }

            public interface IChain2523<out TEntity, out TProperty, in TInput, TInvariant>
                : IQuery2523<TEntity>
            {
            }

            public sealed class Query2523<TEntity> : IQuery2523<TEntity>
            {
                public Query2523(int count) => Count = count;
                public int Count { get; }
            }

            public sealed class Chain2523<TEntity, TProperty, TInput, TInvariant>
                : IChain2523<TEntity, TProperty, TInput, TInvariant>
            {
                public Chain2523(int count) => Count = count;
                public int Count { get; }
            }

            public sealed class MetadataEntity2523
            {
                public MetadataChild2523? Child { get; set; }
                public MetadataOther2523? Other { get; set; }
            }

            public sealed class MetadataChild2523 { }
            public sealed class MetadataOther2523 { }

            public static class QueryExtensions2523
            {
                public static IChain2523<TEntity, TProperty, string, string>
                    Include2523<TEntity, TProperty>(
                        this IQuery2523<TEntity> source,
                        Expression<Func<TEntity, TProperty>> selector)
                    => new Chain2523<TEntity, TProperty, string, string>(
                        source.Count + 1);
            }
            """;

        var compilation = CSharpCompilation.Create(
            "Issue2523.Metadata",
            new[] { CSharpSyntaxTree.ParseText(fixtureSource) },
            TrustedPlatformAssemblies().Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        using var pe = File.Create(outputPath);
        var result = compilation.Emit(pe);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static (int ExitCode, string Output) Compile(
        string sourcePath,
        string outputPath,
        string fixturePath)
    {
        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/reference:" + fixturePath,
        };
        args.AddRange(TrustedPlatformAssemblies().Select(path => "/reference:" + path));
        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args.ToArray()), stdout.ToString() + stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string Run(string outputPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(outputPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(outputPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start issue #2523 executable.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "Issue #2523 executable timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exec failed ({process.ExitCode}):\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static string NewDirectory()
    {
        var root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts", "Issue2523");
        var directory = Path.Combine(root, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrWhiteSpace(value)
            ? Array.Empty<string>()
            : value.Split(Path.PathSeparator).Where(File.Exists);
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch
        {
        }
    }
}

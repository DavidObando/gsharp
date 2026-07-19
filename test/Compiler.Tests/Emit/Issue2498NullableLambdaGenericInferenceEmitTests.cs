// <copyright file="Issue2498NullableLambdaGenericInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
/// Runtime, metadata, C# consumer, and ILVerify coverage for issue #2498.
/// </summary>
public sealed class Issue2498NullableLambdaGenericInferenceEmitTests
{
    [Fact]
    public void OahuIteratorShape_SelectToArray_RunsAndVerifies()
    {
        const string source = """
            package Issue2498.Iterator
            import System
            import System.Collections.Generic
            import System.Linq

            func Build2498[T](source []IEnumerable[T]) []IEnumerator[T]? {
                let values = source
                    .Select((enumerable IEnumerable[T]) -> enumerable.GetEnumerator())
                    .Select((enumerator IEnumerator[T]) ->
                        if enumerator.MoveNext() {
                            enumerator
                        } else {
                            default(IEnumerator[T]?)
                        })
                    .ToArray()
                values[0] = nil
                return values
            }

            func Main() {
                let source = []IEnumerable[int32]{
                    []int32{1},
                    []int32{},
                }
                let values = Build2498[int32](source)
                Console.WriteLine(values[0] == nil)
                Console.WriteLine(values[1] == nil)
            }
            """;

        Assert.Equal("True\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void GeneralizedImportedAndSourceGenericShapes_RunAndVerify()
    {
        const string source = """
            package Issue2498.Runtime
            import System
            import System.Collections.Generic
            import System.Linq

            func Maybe2498(value string) string? ->
                if value.Length > 0 { value } else { nil }

            func Project2498[A, B](source []A, selector (A) -> B) []B ->
                source.Select(selector).ToArray()

            func MaybeComparable2498(value string) IComparable? -> Maybe2498(value)

            func MaybeList2498(value string) List[IComparable?] {
                let result = List[IComparable?]()
                result.Add(MaybeComparable2498(value))
                return result
            }

            func Main() {
                let source = []string{"value", ""}

                let array = source.Select((value string) -> Maybe2498(value)).ToArray()
                array[0] = nil
                Console.WriteLine(array[0] == nil)
                Console.WriteLine(array[1] == nil)

                let list = source.Select(Maybe2498).ToList()
                list[0] = nil
                Console.WriteLine(list[0] == nil)

                let nested = source.Select((value string) -> MaybeList2498(value)).ToArray()
                nested[0][0] = nil
                Console.WriteLine(nested[0][0] == nil)

                let projected = Project2498(source, (value string) -> Maybe2498(value))
                projected[0] = nil
                Console.WriteLine(projected[0] == nil)

                let groups = source.GroupBy((value string) -> Maybe2498(value)).ToArray()
                Console.WriteLine(groups[1].Key == nil)
            }
            """;

        Assert.Equal("True\nTrue\nTrue\nTrue\nTrue\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void EmittedNullability_RoundTripsAndCSharpConsumerAcceptsNullWrites()
    {
        const string source = """
            package Issue2498.Metadata
            import System.Collections.Generic
            import System.Linq

            func Maybe2498Metadata(value string) string? ->
                if value.Length > 0 { value } else { nil }

            class Api2498 {
                shared {
                    func Build(source []string) []string? ->
                        source.Select((value string) -> Maybe2498Metadata(value)).ToArray()

                    func BuildList(source []string) List[string?] ->
                        source.Select((value string) -> Maybe2498Metadata(value)).ToList()

                    func BuildNested(source []string) []List[string?] ->
                        source.Select((value string) -> {
                            let result = List[string?]()
                            result.Add(Maybe2498Metadata(value))
                            return result
                        }).ToArray()
                }
            }
            """;

        WithCompiledLibrary(source, (dllPath, references) =>
        {
            var assembly = Assembly.Load(File.ReadAllBytes(dllPath));
            var api = assembly.GetType("Issue2498.Metadata.Api2498", throwOnError: true)!;
            var nullability = new NullabilityInfoContext();

            var build = nullability.Create(GetMethod(api, "Build").ReturnParameter);
            Assert.Equal(NullabilityState.Nullable, build.ElementType!.ReadState);

            var buildList = nullability.Create(GetMethod(api, "BuildList").ReturnParameter);
            Assert.Equal(NullabilityState.Nullable, buildList.GenericTypeArguments[0].ReadState);

            var buildNested = nullability.Create(GetMethod(api, "BuildNested").ReturnParameter);
            Assert.Equal(
                NullabilityState.Nullable,
                buildNested.ElementType!.GenericTypeArguments[0].ReadState);

            const string consumerSource = """
                #nullable enable
                using Issue2498.Metadata;

                public static class Consumer2498
                {
                    public static void WriteNulls()
                    {
                        Api2498.Build(["x"])[0] = null;
                        Api2498.BuildList(["x"])[0] = null;
                        Api2498.BuildNested(["x"])[0][0] = null;
                    }
                }
                """;

            var compilation = CSharpCompilation.Create(
                "Issue2498.Consumer",
                new[] { CSharpSyntaxTree.ParseText(consumerSource) },
                TrustedPlatformAssemblies()
                    .Select(path => MetadataReference.CreateFromFile(path))
                    .Append(MetadataReference.CreateFromFile(dllPath)),
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable,
                    generalDiagnosticOption: ReportDiagnostic.Error));
            using var stream = new MemoryStream();
            var result = compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        });
    }

    private static MethodInfo GetMethod(Type type, string name)
        => type.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Method '{name}' was not emitted.");

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2498_run_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            var (exitCode, stdout, stderr) = Compile(sourcePath, outputPath, "exe");
            Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            IlVerifier.Verify(outputPath);

            var runtimeConfig = Path.ChangeExtension(outputPath, ".runtimeconfig.json");
            File.WriteAllText(runtimeConfig, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(runtimeConfig);
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var runtimeOutput = process.StandardOutput.ReadToEnd();
            var runtimeError = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"dotnet exec failed ({process.ExitCode}):\nstdout:\n{runtimeOutput}\nstderr:\n{runtimeError}");
            return runtimeOutput.Replace("\r\n", "\n");
        }
        finally
        {
            TryDelete(directory);
        }
    }

    private static void WithCompiledLibrary(
        string source,
        Action<string, IReadOnlyList<string>> assertion)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2498_lib_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            var (exitCode, stdout, stderr) = Compile(sourcePath, outputPath, "library");
            Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            var references = TrustedPlatformAssemblies().ToArray();
            IlVerifier.Verify(outputPath, additionalReferences: references);
            assertion(outputPath, references);
        }
        finally
        {
            TryDelete(directory);
        }
    }

    private static (int ExitCode, string Stdout, string Stderr) Compile(
        string sourcePath,
        string outputPath,
        string target)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                sourcePath,
            });
            return (exitCode, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
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

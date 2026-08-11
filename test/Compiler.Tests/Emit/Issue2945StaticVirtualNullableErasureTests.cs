// <copyright file="Issue2945StaticVirtualNullableErasureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2945: static-virtual interface properties use the same declared-type
/// nullable erasure as instance interface properties. Tests load every emitted
/// type, then execute get/set dispatch through constrained generic calls in a
/// child process; IL verification is additional evidence, not the runtime gate.
/// </summary>
public class Issue2945StaticVirtualNullableErasureTests
{
    [Fact]
    public void NullableErasureMatrix_LoadsAndDispatchesThroughClrSlots()
    {
        const string source = """
            package Issue2945Matrix

            sealed interface IGet[T] {
                shared { prop Value T? { get; } }
            }

            struct IntImplicit : IGet[int32] {
                shared { prop Value int32 -> 11 }
            }

            struct IntExplicit : IGet[int32] {
                shared {
                    private prop (IGet[int32]) Value int32 -> 12
                }
            }

            class TextImplicit : IGet[string] {
                shared { prop Value string -> "text" }
            }

            struct OpenImplicit[T] : IGet[T] {
                shared { prop Value T -> default(T) }
            }

            open class Animal { }
            class Cat : Animal { }

            sealed interface IClassGet[T Animal] {
                shared { prop Value T? { get; } }
            }

            class CatImplicit : IClassGet[Cat] {
                shared { prop Value Cat -> Cat() }
            }

            sealed interface ISet[T] {
                shared { prop Value T? { get; set; } }
            }

            class TextSet : ISet[string] {
                shared {
                    var Stored string? = "before"
                    prop Value string? {
                        get { return TextSet.Stored }
                        set { TextSet.Stored = value }
                    }
                }
            }

            class ExplicitTextSet : ISet[string] {
                shared {
                    var Stored string? = "explicit-before"
                    private prop (ISet[string]) Value string? {
                        get { return ExplicitTextSet.Stored }
                        set { ExplicitTextSet.Stored = value }
                    }
                }
            }

            sealed interface IStructSet[T struct] {
                shared { prop Value T? { get; set; } }
            }

            struct StructSet : IStructSet[int32] {
                shared {
                    var Stored int32? = 7
                    prop Value int32? {
                        get { return StructSet.Stored }
                        set { StructSet.Stored = value }
                    }
                }
            }

            sealed interface ISliceGet[T] { shared { prop Value []T? { get; } } }
            struct SliceGet : ISliceGet[int32] { shared { prop Value []int32 -> []int32{1} } }

            sealed interface IArrayGet[T] { shared { prop Value [3]T? { get; } } }
            struct ArrayGet : IArrayGet[int32] { shared { prop Value [3]int32 -> [3]int32{1, 2, 3} } }

            sealed interface IMapGet[T] { shared { prop Value map[string,T?] { get; } } }
            struct MapGet : IMapGet[int32] { shared { prop Value map[string,int32] -> map[string,int32]{"one": 1} } }

            sealed interface IFuncArgumentGet[T] { shared { prop Value func(T?) int32 { get; } } }
            struct FuncArgumentGet : IFuncArgumentGet[int32] { shared { prop Value func(int32) int32 -> func(value int32) int32 { return value + 1 } } }

            sealed interface IFuncReturnGet[T] { shared { prop Value func(int32) T? { get; } } }
            struct FuncReturnGet : IFuncReturnGet[int32] { shared { prop Value func(int32) int32 -> func(value int32) int32 { return value + 2 } } }
            """;

        const string consumer = """
            using System;
            using Issue2945Matrix;

            Console.WriteLine(Read<IntImplicit, int>());
            Console.WriteLine(Read<IntExplicit, int>());
            Console.WriteLine(Read<TextImplicit, string>());
            Console.WriteLine(Read<OpenImplicit<int>, int>());
            Console.WriteLine(ReadClass<CatImplicit, Cat>() is not null);
            Console.WriteLine(ReadSet<TextSet, string>());
            ClearSet<TextSet, string>();
            Console.WriteLine(ReadSet<TextSet, string>() ?? "nil");
            Console.WriteLine(ReadSet<ExplicitTextSet, string>());
            Set<ExplicitTextSet, string>("explicit-after");
            Console.WriteLine(ReadSet<ExplicitTextSet, string>());
            Console.WriteLine(ReadStructSet<StructSet, int>());
            SetStruct<StructSet, int>(9);
            Console.WriteLine(ReadStructSet<StructSet, int>());

            static T? Read<TImpl, T>()
                where T : notnull
                where TImpl : IGet<T>
            {
                return TImpl.Value;
            }

            static T? ReadClass<TImpl, T>()
                where T : Animal
                where TImpl : IClassGet<T>
            {
                return TImpl.Value;
            }

            static T? ReadSet<TImpl, T>()
                where T : class
                where TImpl : ISet<T>
            {
                return TImpl.Value;
            }

            static void ClearSet<TImpl, T>()
                where T : class
                where TImpl : ISet<T>
            {
                TImpl.Value = null;
            }

            static void Set<TImpl, T>(T value)
                where T : class
                where TImpl : ISet<T>
            {
                TImpl.Value = value;
            }

            static T? ReadStructSet<TImpl, T>()
                where T : struct
                where TImpl : IStructSet<T>
            {
                return TImpl.Value;
            }

            static void SetStruct<TImpl, T>(T? value)
                where T : struct
                where TImpl : IStructSet<T>
            {
                TImpl.Value = value;
            }
            """;

        const string expected = """
            11
            12
            text
            0
            True
            before
            nil
            explicit-before
            explicit-after
            7
            9
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var libraryPath = CompileGSharp(source, directory, "Issue2945Matrix.dll", target: "library");
            _ = Assembly.Load(File.ReadAllBytes(libraryPath)).GetTypes();
            var consumerPath = CompileCSharpConsumer(consumer, libraryPath, directory);
            Assert.Equal(expected + Environment.NewLine, RunChild(consumerPath, directory));
            IlVerifier.Verify(libraryPath);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void GSharpConstrainedRead_UsesErasedSlotTypeAndRuns()
    {
        const string source = """
            package Issue2945GSharp
            import System

            sealed interface I[T] {
                shared { prop Value T? { get; } }
            }

            struct C : I[int32] {
                shared { prop Value int32 -> 1 }
            }

            func Touch[T I[int32]](witness T) {
                var value = T.Value
            }

            func Main() {
                Touch(C{})
                Console.WriteLine("ok")
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var outputPath = CompileGSharp(source, directory, "Issue2945GSharp.dll", target: "exe");
            _ = Assembly.Load(File.ReadAllBytes(outputPath)).GetTypes();
            Assert.Equal($"ok{Environment.NewLine}", RunChild(outputPath, directory));
            IlVerifier.Verify(
                outputPath,
                ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface,
                ignoredErrorScope: @"<Program>\.Touch$");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ValueNullableAndInvariantStaticSlots_RemainRejected()
    {
        const string source = """
            package Issue2945Rejected
            import System.Collections.Generic

            sealed interface IConcrete {
                shared { prop Value int32? { get; } }
            }
            struct ConcreteValueCovariance : IConcrete {
                shared { prop Value int32 -> 1 }
            }

            sealed interface IStruct[T struct] {
                shared { prop Value T? { get; } }
            }
            struct StructConstrained[T struct] : IStruct[T] {
                shared { prop Value T -> default(T) }
            }

            sealed interface ISetter[T] {
                shared { prop Value T? { get; set; } }
            }
            class SetterNullabilityMismatch : ISetter[string] {
                shared { prop Value string { get; set; } }
            }

            sealed interface INonNullable[T] {
                shared { prop Value T { get; } }
            }
            class NullableImplementation : INonNullable[string] {
                shared { prop Value string? -> nil }
            }

            sealed interface IWrongType {
                shared { prop Value int32 { get; } }
            }
            class WrongType : IWrongType {
                shared { prop Value string -> "wrong" }
            }

            interface INestedList[T] {
                prop Value List[T?] { get; }
            }
            class NestedListMismatch : INestedList[int32] {
                prop Value List[int32] { get; }
            }
            """;

        var directory = CreateWorkDirectory();
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "Issue2945Rejected.dll");
            File.WriteAllText(sourcePath, source);

            var (exitCode, output) = Compile(
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath);

            Assert.NotEqual(0, exitCode);
            Assert.False(File.Exists(outputPath));
            Assert.Equal(5, CountOccurrences(output, "error GS0397:"));
            Assert.Equal(1, CountOccurrences(output, "error GS0187:"));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileGSharp(string source, string directory, string outputName, string target)
    {
        var sourcePath = Path.Combine(directory, Path.GetFileNameWithoutExtension(outputName) + ".gs");
        var outputPath = Path.Combine(directory, outputName);
        File.WriteAllText(sourcePath, source);

        var (exitCode, output) = Compile(
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            sourcePath);
        Assert.True(exitCode == 0, "gsc failed:\n" + output);
        return outputPath;
    }

    private static (int ExitCode, string Output) Compile(params string[] arguments)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(arguments);
            return (exitCode, stdout.ToString() + stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string CompileCSharpConsumer(string source, string libraryPath, string directory)
    {
        var outputPath = Path.Combine(directory, "Issue2945Consumer.dll");
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(libraryPath));
        var compilation = CSharpCompilation.Create(
            "Issue2945Consumer",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(
                OutputKind.ConsoleApplication,
                nullableContextOptions: NullableContextOptions.Enable));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics));
        WriteRuntimeConfig(outputPath);
        return outputPath;
    }

    private static string RunChild(string assemblyPath, string workingDirectory)
    {
        WriteRuntimeConfig(assemblyPath);
        var runtimeConfig = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = workingDirectory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfig);
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet child process.");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            throw new Xunit.Sdk.XunitException("dotnet child process timed out.");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult();
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(
            process.ExitCode == 0,
            $"dotnet child exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private static void WriteRuntimeConfig(string assemblyPath)
    {
        File.WriteAllText(
            Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
            """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": {
                  "name": "Microsoft.NETCore.App",
                  "version": "10.0.0"
                }
              }
            }
            """);
    }

    private static string CreateWorkDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2945-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static int CountOccurrences(string text, string value)
        => text.Split(value, StringSplitOptions.None).Length - 1;
}

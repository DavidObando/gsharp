// <copyright file="Issue4412SuspendMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #4412: suspend method groups capture context through a verifier-safe thunk.</summary>
/// <remarks>
/// ADR-0154 witness: on the parent commit the direct and base cases fail
/// ILVerify with two DelegateCtor errors, while the imported structural
/// conversion reports GS0218 because its hidden context parameter is counted
/// as a source parameter.
/// </remarks>
[Collection("Issue4412Console")]
public sealed class Issue4412SuspendMethodGroupEmitTests
{
    [Fact]
    public void DirectInstanceAndBaseSuspendMethodGroups_VerifyAndRun()
    {
        const string source = """
            package Issue4412
            import System

            delegate Runner(value int32) System.Threading.Tasks.ValueTask[int32];

            open class A {
                open suspend func M(value int32) int32 {
                    return value + 1
                }

                suspend func Wait(ch chan[int32]) string {
                    select {
                    case cancelled {
                        return "cancelled"
                    }
                    case <-ch {
                        return "received"
                    }
                    }
                }
            }

            class B : A {
                override suspend func M(value int32) int32 {
                    return value + 10
                }

                suspend func BaseDelegate(value int32) int32 {
                    let f = base.M
                    return await f(value)
                }
            }

            suspend func run() {
                let a A = B()
                let direct = a.M
                Console.WriteLine(direct(1))
                var named Runner = a.M
                Console.WriteLine(await named(2))
                Console.WriteLine(B().BaseDelegate(1))
                scope {
                    let wait = a.Wait
                    ctx.TryCancel()
                    Console.WriteLine(await wait(chan[int32](1)))
                }
            }

            run()
            """;

        var directory = PrepareDirectory(nameof(DirectInstanceAndBaseSuspendMethodGroups_VerifyAndRun));
        try
        {
            var outputPath = Compile(directory, "App", source, "/target:exe");
            IlVerifier.Verify(outputPath, new[] { Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal(
                $"11{Environment.NewLine}12{Environment.NewLine}2{Environment.NewLine}cancelled{Environment.NewLine}",
                Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedInstanceSuspendMethodGroup_VerifiesAndRuns()
    {
        const string library = """
            package Lib

            public open class A {
                public open suspend func M(value int32) int32 {
                    return value + 1
                }

                public suspend func Wait(ch chan[int32]) string {
                    select {
                    case cancelled {
                        return "cancelled"
                    }
                    case <-ch {
                        return "received"
                    }
                    }
                }
            }
            """;
        const string app = """
            package App
            import System
            import Lib

            suspend func run() {
                let direct (int32) -> System.Threading.Tasks.ValueTask[int32] = A().M
                Console.WriteLine(await direct(1))
                scope {
                    let wait (chan[int32]) -> System.Threading.Tasks.ValueTask[string] = A().Wait
                    ctx.TryCancel()
                    Console.WriteLine(await wait(chan[int32](1)))
                }
            }

            run()
            """;

        var directory = PrepareDirectory(nameof(ImportedInstanceSuspendMethodGroup_VerifiesAndRuns));
        try
        {
            var libraryPath = Compile(directory, "Lib", library, "/target:library");
            var appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath);
            IlVerifier.Verify(
                appPath,
                new[] { libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"2{Environment.NewLine}cancelled{Environment.NewLine}", Run(appPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedStaticAndExtensionSuspendMethodGroups_VerifyAndRun()
    {
        const string library = """
            package Lib

            public class Number {
                public let value int32
                public init(value int32) {
                    this.value = value
                }
            }

            public suspend func Twice(value int32) int32 {
                return value * 2
            }

            public suspend func (number Number) Add(value int32) int32 {
                return number.value + value
            }
            """;
        const string app = """
            package App
            import System
            import System.Linq
            import Lib

            func Register[T](callback (int32) -> T) T {
                return callback(11)
            }

            class Holder {
                let instanceCallback (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
                shared {
                    let sharedCallback (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
                }
            }

            suspend func run() {
                let values = []int32{7}
                for task in Enumerable.Select(values, Twice) {
                    Console.WriteLine(await task)
                }
                let twice (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
                let add (int32) -> System.Threading.Tasks.ValueTask[int32] = Number(10).Add
                Console.WriteLine(await twice(3))
                Console.WriteLine(await add(4))
                Console.WriteLine(await Register(Twice))
            }

            let top (int32) -> System.Threading.Tasks.ValueTask[int32] = Twice
            Console.WriteLine(top(5).AsTask().GetAwaiter().GetResult())
            Console.WriteLine(Holder.sharedCallback(8).AsTask().GetAwaiter().GetResult())
            Console.WriteLine(Holder().instanceCallback(9).AsTask().GetAwaiter().GetResult())
            run()
            """;

        var directory = PrepareDirectory(nameof(ImportedStaticAndExtensionSuspendMethodGroups_VerifyAndRun));
        try
        {
            var libraryPath = Compile(directory, "Lib", library, "/target:library");
            var appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath);
            IlVerifier.Verify(
                appPath,
                new[] { libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal(
                $"10{Environment.NewLine}16{Environment.NewLine}18{Environment.NewLine}14{Environment.NewLine}6{Environment.NewLine}14{Environment.NewLine}22{Environment.NewLine}",
                Run(appPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedByRefSuspendMethodGroup_VerifiesAndRuns()
    {
        const string library = """
            using System.Threading.Tasks;
            using Gsharp.Concurrency;

            namespace Interop;

            public delegate ValueTask<int> RefRunner(ref int value);

            public static class Api
            {
                [Suspending]
                public static ValueTask<int> Increment(ref int value, Context context)
                {
                    value++;
                    return new ValueTask<int>(value);
                }
            }
            """;
        const string app = """
            package App
            import System
            import Interop

            suspend func run() {
                var value = 4
                let callback RefRunner = Api.Increment
                Console.WriteLine(await callback(ref value))
                Console.WriteLine(value)
            }

            run()
            """;

        var directory = PrepareDirectory(nameof(ImportedByRefSuspendMethodGroup_VerifiesAndRuns));
        try
        {
            var libraryPath = CompileCSharpLibrary(directory, "Interop", library);
            var appPath = Compile(directory, "App", app, "/target:exe", "/reference:" + libraryPath);
            IlVerifier.Verify(
                appPath,
                new[] { libraryPath, Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"5{Environment.NewLine}5{Environment.NewLine}", Run(appPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void StaticInitializerSuspendMethodGroups_VerifyAndRun()
    {
        const string source = """
            package Issue4412
            import System
            import System.Threading.Tasks

            suspend func Declared(value int32) int32 {
                return value + 1
            }

            func Inferred(value int32) int32 {
                return await Task.FromResult(value + 2)
            }

            class Holder {
                shared {
                    var Result int32
                    init {
                        let declared = Declared
                        let inferred = Inferred
                        Result = declared(3).AsTask().GetAwaiter().GetResult() + inferred(4)
                    }
                }
            }

            Console.WriteLine(Holder.Result)
            """;

        var directory = PrepareDirectory(nameof(StaticInitializerSuspendMethodGroups_VerifyAndRun));
        try
        {
            var outputPath = Compile(directory, "App", source, "/target:exe");
            IlVerifier.Verify(outputPath, new[] { Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"10{Environment.NewLine}", Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void UnresolvedSuspendMethodGroupInStaticInitializer_ReportsWithoutCrashing()
    {
        const string source = """
            package Issue4412

            suspend func Pick(value int32) int32 {
                return value
            }

            func Pick(value string) string {
                return value
            }

            class Holder {
                shared {
                    init {
                        let callback = Pick
                    }
                }
            }
            """;

        var directory = PrepareDirectory(nameof(UnresolvedSuspendMethodGroupInStaticInitializer_ReportsWithoutCrashing));
        try
        {
            var diagnostics = CompileExpectingError(directory, "App", source, "/target:library");
            Assert.Contains("GS0582", diagnostics, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void SuspendMethodGroupInsideAsyncLet_CapturesCellContext()
    {
        const string source = """
            package Issue4412
            import System

            suspend func Value() int32 {
                return 7
            }

            suspend func Invoke(callback () -> System.Threading.Tasks.ValueTask[int32]) int32 {
                return await callback()
            }

            func run() {
                scope {
                    async let result = Invoke(Value)
                    Console.WriteLine(await result)
                }
            }

            run()
            """;

        var directory = PrepareDirectory(nameof(SuspendMethodGroupInsideAsyncLet_CapturesCellContext));
        try
        {
            var outputPath = Compile(directory, "App", source, "/target:exe");
            IlVerifier.Verify(outputPath, new[] { Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"7{Environment.NewLine}", Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void InferredSuspendMethodGroup_VerifiesAndRuns()
    {
        const string source = """
            package Issue4412
            import System
            import System.Threading.Tasks

            func Take(ch chan[int32]) int32 {
                return <-ch
            }

            suspend func AddOne(value int32) int32 {
                return value + 1
            }

            class Holder {
                let take (chan[int32]) -> int32 = Take

                suspend func AddOne(value int32) int32 {
                    return value + 1
                }
            }

            func Make() Holder {
                return await Task.FromResult(Holder())
            }

            let ch = chan[int32](1)
            ch <- 42
            let addOne = AddOne
            let take = Take
            Console.WriteLine(addOne(1))
            Console.WriteLine(take(ch))
            let second = chan[int32](1)
            second <- 43
            Console.WriteLine(Holder().take(second))
            let receiverMethod = Make().AddOne
            Console.WriteLine(receiverMethod(4))
            """;

        var directory = PrepareDirectory(nameof(InferredSuspendMethodGroup_VerifiesAndRuns));
        try
        {
            var outputPath = Compile(directory, "App", source, "/target:exe");
            IlVerifier.Verify(outputPath, new[] { Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"2{Environment.NewLine}42{Environment.NewLine}43{Environment.NewLine}5{Environment.NewLine}", Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void GenericStaticSuspendMethodGroup_PreservesConstructedOwner()
    {
        const string source = """
            package Issue4412
            import System

            class Box[T] {
                shared {
                    suspend func Identity(value T) T {
                        return value
                    }
                }
            }

            suspend func run() {
                let identity (int32) -> System.Threading.Tasks.ValueTask[int32] = Box[int32].Identity
                Console.WriteLine(await identity(9))
            }

            run()
            """;

        var directory = PrepareDirectory(nameof(GenericStaticSuspendMethodGroup_PreservesConstructedOwner));
        try
        {
            var outputPath = Compile(directory, "App", source, "/target:exe");
            IlVerifier.Verify(outputPath, new[] { Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal($"9{Environment.NewLine}", Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void BaseConstructorSuspendMethodGroups_VerifyAndRun()
    {
        const string source = """
            package Issue4412
            import System

            delegate AsyncRunner(value int32) System.Threading.Tasks.ValueTask[int32];

            suspend func Twice(value int32) int32 {
                return value * 2
            }

            func Take(ch chan[int32]) int32 {
                return <-ch
            }

            open class AsyncBase {
                let callback AsyncRunner
                init(callback AsyncRunner) {
                    this.callback = callback
                }
                func Run(value int32) int32 {
                    return callback(value).AsTask().GetAwaiter().GetResult()
                }
            }

            class PrimaryAsync : AsyncBase(Twice) { }
            class ExplicitAsync : AsyncBase {
                init() : base(Twice) { }
            }

            open class SyncBase {
                let callback (chan[int32]) -> int32
                init(callback (chan[int32]) -> int32) {
                    this.callback = callback
                }
                func Run(ch chan[int32]) int32 {
                    return callback(ch)
                }
            }

            class PrimarySync : SyncBase(Take) { }
            class ExplicitSync : SyncBase {
                init() : base(Take) { }
            }

            Console.WriteLine(PrimaryAsync().Run(3))
            Console.WriteLine(ExplicitAsync().Run(4))
            let first = chan[int32](1)
            first <- 5
            Console.WriteLine(PrimarySync().Run(first))
            let second = chan[int32](1)
            second <- 6
            Console.WriteLine(ExplicitSync().Run(second))
            """;

        var directory = PrepareDirectory(nameof(BaseConstructorSuspendMethodGroups_VerifyAndRun));
        try
        {
            var outputPath = Compile(directory, "App", source, "/target:exe");
            IlVerifier.Verify(outputPath, new[] { Path.Combine(directory, "Gsharp.Runtime.Channels.dll") });
            Assert.Equal(
                $"6{Environment.NewLine}8{Environment.NewLine}5{Environment.NewLine}6{Environment.NewLine}",
                Run(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string PrepareDirectory(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, name);
        if (Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
        }

        Directory.CreateDirectory(path);
        return path;
    }

    private static string Compile(string directory, string assemblyName, string source, params string[] extra)
    {
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new List<string>
        {
            "/out:" + outputPath,
            "/targetframework:net10.0",
        };
        arguments.AddRange(extra);
        arguments.AddRange(TrustedPlatformAssemblies().Select(reference => "/reference:" + reference));
        arguments.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            Program.Main(arguments.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            File.Exists(outputPath) && new FileInfo(outputPath).Length > 0,
            stdout.ToString() + stderr.ToString());
        return outputPath;
    }

    private static string CompileCSharpLibrary(string directory, string assemblyName, string source)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(typeof(Gsharp.Concurrency.Context).Assembly.Location));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        var result = compilation.Emit(outputPath);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        RewriteMetadataString(outputPath, "context", "<>ctx");
        return outputPath;
    }

    private static void RewriteMetadataString(string assemblyPath, string from, string to)
    {
        var bytes = File.ReadAllBytes(assemblyPath);
        var source = System.Text.Encoding.UTF8.GetBytes(from + "\0");
        var replacement = System.Text.Encoding.UTF8.GetBytes(to + "\0");
        Assert.True(replacement.Length <= source.Length);
        var matches = Enumerable.Range(0, bytes.Length - source.Length + 1)
            .Where(offset => bytes.AsSpan(offset, source.Length).SequenceEqual(source))
            .ToArray();
        Assert.Single(matches);
        Array.Clear(bytes, matches[0], source.Length);
        replacement.CopyTo(bytes, matches[0]);
        File.WriteAllBytes(assemblyPath, bytes);
    }

    private static string CompileExpectingError(string directory, string assemblyName, string source, params string[] extra)
    {
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new List<string>
        {
            "/out:" + outputPath,
            "/targetframework:net10.0",
        };
        arguments.AddRange(extra);
        arguments.AddRange(TrustedPlatformAssemblies().Select(reference => "/reference:" + reference));
        arguments.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            Program.Main(arguments.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.False(File.Exists(outputPath));
        return stdout.ToString() + stderr.ToString();
    }

    private static string Run(string assemblyPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
        }) ?? throw new InvalidOperationException("could not start dotnet");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(milliseconds: 30_000))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            Assert.Fail("timed out after 30s");
        }

        var output = stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult();
        Assert.Equal(0, process.ExitCode);
        return output.ReplaceLineEndings(Environment.NewLine);
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(value)
            ? Enumerable.Empty<string>()
            : value.Split(Path.PathSeparator).Where(File.Exists);
    }
}

[CollectionDefinition("Issue4412Console", DisableParallelization = true)]
public sealed class Issue4412ConsoleCollection
{
}

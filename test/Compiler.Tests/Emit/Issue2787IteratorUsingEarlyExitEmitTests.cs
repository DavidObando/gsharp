// <copyright file="Issue2787IteratorUsingEarlyExitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2787: iterator control flow may bypass a using declaration, so its
/// cleanup must run only after the resource initializer completed.
/// </summary>
public class Issue2787IteratorUsingEarlyExitEmitTests
{
    [Fact]
    public void AsyncIterator_MissingFileGotoBeforeUsing_EnumeratesEmpty()
    {
        const string source = """
            package i2787missing
            import System
            import System.IO
            import System.Collections.Generic
            import System.Threading.Tasks

            async func read(path string) IAsyncEnumerable[int32] {
                if !File.Exists(path) {
                    goto done
                }
                using let reader = StreamReader(path)
                while await reader.ReadLineAsync() != nil {
                    yield 1
                }
                done:
                {
                }
            }

            async func run() {
                var count = 0
                await for value in read(Path.Combine(Path.GetTempPath(), "i2787-" + Guid.NewGuid().ToString("n"))) {
                    count++
                }
                Console.WriteLine("count=" + count.ToString())
            }
            run().GetAwaiter().GetResult()
            """;

        Assert.Equal("count=0\n", CompileAndRun(source));
    }

    [Fact]
    public void SyncIterator_GotoBeforeUsing_SkipsCleanup()
    {
        const string source = """
            package i2787syncskip
            import System
            import System.Collections.Generic

            public var trace = ""

            class Resource : IDisposable {
                init() {
                    trace = trace + "+"
                }
                func Dispose() {
                    trace = trace + "-"
                }
            }

            func values(skip bool) IEnumerable[int32] {
                if skip {
                    goto done
                }
                using let resource = Resource{}
                yield 1
                done:
                {
                }
            }

            for value in values(true) {
                trace = trace + "value"
            }
            Console.WriteLine(trace)
            """;

        Assert.Equal("\n", CompileAndRun(source));
    }

    [Fact]
    public void AsyncIterator_NestedUsings_EarlyConsumerBreak_DisposesInReverseOrder()
    {
        const string source = """
            package i2787order
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            public var trace = ""

            class Resource : IDisposable {
                private let name string
                init(name string) {
                    this.name = name
                    trace = trace + "+" + name
                }
                func Dispose() {
                    trace = trace + "-" + name
                }
            }

            async func values() IAsyncEnumerable[int32] {
                using let outer = Resource("A")
                {
                    using let inner = Resource("B")
                    await Task.Yield()
                    yield 1
                    yield 2
                }
            }

            async func run() {
                let enumerator = values().GetAsyncEnumerator()
                await enumerator.MoveNextAsync()
                await enumerator.DisposeAsync()
            }
            run().GetAwaiter().GetResult()
            Console.WriteLine(trace)
            """;

        Assert.Equal("+A+B-B-A\n", CompileAndRun(source));
    }

    [Fact]
    public void AsyncIterator_GotoBetweenUsings_DisposesOnlyInitializedResource()
    {
        const string source = """
            package i2787partial
            import System
            import System.Collections.Generic

            public var trace = ""

            class Resource : IDisposable {
                private let name string
                init(name string) {
                    this.name = name
                    trace = trace + "+" + name
                }
                func Dispose() {
                    trace = trace + "-" + name
                }
            }

            async func values() IAsyncEnumerable[int32] {
                using let first = Resource("A")
                goto done
                using let second = Resource("B")
                yield 1
                done:
                {
                }
            }

            async func run() {
                await for value in values() {
                    trace = trace + "value"
                }
            }
            run().GetAwaiter().GetResult()
            Console.WriteLine(trace)
            """;

        Assert.Equal("+A-A\n", CompileAndRun(source));
    }

    [Fact]
    public void AsyncIterator_GotoAndException_DisposeInitializedResource()
    {
        const string source = """
            package i2787exits
            import System
            import System.Collections.Generic

            public var trace = ""

            class Resource : IDisposable {
                init() {
                    trace = trace + "+"
                }
                func Dispose() {
                    trace = trace + "-"
                }
            }

            async func values(mode int32) IAsyncEnumerable[int32] {
                using let resource = Resource{}
                if mode == 0 {
                    goto done
                }
                yield 1
                throw Exception("boom")
                done:
                {
                }
            }

            async func run() {
                await for value in values(0) {
                    trace = trace + "value"
                }
                trace = trace + "|"
                try {
                    await for value in values(1) {
                    }
                } catch (ex Exception) {
                    trace = trace + "!"
                }
            }
            run().GetAwaiter().GetResult()
            Console.WriteLine(trace)
            """;

        Assert.Equal("+-|+-!\n", CompileAndRun(source));
    }

    [Fact]
    public void AsyncIterator_AwaitUsing_DisposesOnlyInitializedResources()
    {
        const string source = """
            package i2787awaitusing
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            public var trace = ""

            class Resource : IAsyncDisposable {
                init() {
                    trace = trace + "+"
                }
                func DisposeAsync() ValueTask {
                    trace = trace + "-"
                    return ValueTask.CompletedTask
                }
            }

            async func values(skip bool) IAsyncEnumerable[int32] {
                if skip {
                    goto done
                }
                await using let resource = Resource{}
                yield 1
                done:
                {
                }
            }

            async func run() {
                await for value in values(true) {
                    trace = trace + "bad"
                }
                let enumerator = values(false).GetAsyncEnumerator()
                await enumerator.MoveNextAsync()
                await enumerator.DisposeAsync()
            }
            run().GetAwaiter().GetResult()
            Console.WriteLine(trace)
            """;

        Assert.Equal("+-\n", CompileAndRun(source));
    }

    [Fact]
    public void Using_Return_DisposesInitializedResourcesInReverseOrder()
    {
        const string source = """
            package i2787return
            import System

            public var trace = ""

            class Resource : IDisposable {
                private let name string
                init(name string) {
                    this.name = name
                    trace = trace + "+" + name
                }
                func Dispose() {
                    trace = trace + "-" + name
                }
            }

            func value() int32 {
                using let outer = Resource("A")
                using let inner = Resource("B")
                return 42
            }

            Console.WriteLine(value().ToString() + ":" + trace)
            """;

        Assert.Equal("42:+A+B-B-A\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_2787_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exitCode;
            try
            {
                exitCode = Program.Main(
                [
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                ]);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(assemblyPath);

            var processInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            processInfo.ArgumentList.Add("exec");
            processInfo.ArgumentList.Add("--runtimeconfig");
            processInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
            processInfo.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(processInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
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
}

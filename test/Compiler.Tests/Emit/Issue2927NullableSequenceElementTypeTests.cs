// <copyright file="Issue2927NullableSequenceElementTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2927: nullable value-type sequence elements retain their runtime
/// element type across binding and iterator metadata emission.
/// </summary>
public class Issue2927NullableSequenceElementTypeTests
{
    [Fact]
    public async Task SyncNullableIteratorElementCaptureLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927Sync
            import System

            func text(value int32?) string {
                if value == nil {
                    return "nil"
                }

                return value.ToString()
            }

            func values() sequence[int32?] {
                for value in []int32?{1, nil, 3} {
                    var read = () -> { return value }
                    yield read()
                }
            }

            func direct() string {
                var result = ""
                for value in []int32?{1, nil, 3} {
                    var read = () -> { return value }
                    result = result + text(read()) + ","
                }

                return result
            }

            var iteratorResult = ""
            for value in values() {
                iteratorResult = iteratorResult + text(value) + ","
            }

            let directResult = direct()
            Console.WriteLine(iteratorResult)
            Console.WriteLine(directResult)
            iteratorResult == directResult
            """;

        await AssertParity(Source, "1,nil,3,", nameof(SyncNullableIteratorElementCaptureLoadsVerifiesAndRuns), evaluateWithInterpreter: true);
    }

    [Fact]
    public async Task AsyncNullableIteratorElementCaptureLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927Async
            import System
            import System.Threading.Tasks

            func text(value int32?) string {
                if value == nil {
                    return "nil"
                }

                return value.ToString()
            }

            async func values() async sequence[int32?] {
                for value in []int32?{1, nil, 3} {
                    var read = () -> { return value }
                    yield read()
                    await Task.Delay(1)
                }
            }

            func direct() string {
                var result = ""
                for value in []int32?{1, nil, 3} {
                    var read = () -> { return value }
                    result = result + text(read()) + ","
                }

                return result
            }

            public var iteratorResult = ""

            async func collect() {
                await for value in values() {
                    iteratorResult = iteratorResult + text(value) + ","
                }
            }

            collect().Wait()
            let directResult = direct()
            Console.WriteLine(iteratorResult)
            Console.WriteLine(directResult)
            iteratorResult == directResult
            """;

        await AssertParity(Source, "1,nil,3,", nameof(AsyncNullableIteratorElementCaptureLoadsVerifiesAndRuns), evaluateWithInterpreter: false);
    }

    [Fact]
    public void NullableSequenceParameterAcceptsList()
    {
        const string Source = """
            package Issue2927Parameter
            import System
            import System.Collections.Generic

            func text(value int32?) string {
                if value == nil {
                    return "nil"
                }

                return value.ToString()
            }

            func collect(values sequence[int32?]) string {
                var result = ""
                for value in values {
                    result = result + text(value) + ","
                }

                return result
            }

            var values = List[int32?]()
            values.Add(1)
            values.Add(nil)
            values.Add(3)
            Console.WriteLine(collect(values))
            """;

        var assemblyPath = Compile(Source, nameof(NullableSequenceParameterAcceptsList));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal("1,nil,3,\n", RunBounded(assemblyPath, nameof(NullableSequenceParameterAcceptsList)));
    }

    [Fact]
    public void GenericNullableSequenceDoesNotRegressToRuntimeCrash()
    {
        const string Source = """
            package Issue2927Generic
            import System

            func text(value int32?) string {
                if value == nil {
                    return "nil"
                }

                return value.ToString()
            }

            func values[T](value T) sequence[T?] {
                yield value
                yield nil
            }

            for value in values[int32](5) {
                Console.WriteLine(text(value))
            }
            """;

        var assemblyPath = Compile(Source, nameof(GenericNullableSequenceDoesNotRegressToRuntimeCrash));
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());

        // The generic value semantics remain tracked by #2927. This guard
        // prevents a partial concrete-type fix from turning existing output
        // into EntryPointNotFoundException.
        var output = RunBounded(assemblyPath, nameof(GenericNullableSequenceDoesNotRegressToRuntimeCrash));
        Assert.True(output is "0\nnil\n" or "5\nnil\n", $"Unexpected output: {output}");
    }

    [Fact]
    public void GenericAsyncNullableSequenceDoesNotRegressToRuntimeCrash()
    {
        const string Source = """
            package Issue2927GenericAsync
            import System
            import System.Threading.Tasks

            func text(value int32?) string {
                if value == nil {
                    return "nil"
                }

                return value.ToString()
            }

            async func values[T](value T) async sequence[T?] {
                yield value
                await Task.Delay(1)
                yield nil
            }

            public var result = ""

            async func collect() {
                await for value in values[int32](5) {
                    result = result + text(value) + ","
                }
            }

            collect().Wait()
            Console.WriteLine(result)
            """;

        var assemblyPath = Compile(Source, nameof(GenericAsyncNullableSequenceDoesNotRegressToRuntimeCrash));
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());

        var output = RunBounded(assemblyPath, nameof(GenericAsyncNullableSequenceDoesNotRegressToRuntimeCrash));
        Assert.True(output is "5,0,\n" or "5,nil,\n", $"Unexpected output: {output}");
    }

    private static async Task AssertParity(string source, string expected, string name, bool evaluateWithInterpreter)
    {
        if (evaluateWithInterpreter)
        {
            var evaluationTask = Task.Run(() => new Compilation(SyntaxTree.Parse(source))
                .Evaluate(new Dictionary<VariableSymbol, object>()));
            Assert.Same(evaluationTask, await Task.WhenAny(evaluationTask, Task.Delay(TimeSpan.FromSeconds(30))));
            var evaluation = await evaluationTask;
            Assert.Empty(evaluation.Diagnostics);
            Assert.Equal(true, evaluation.Value);
        }

        var assemblyPath = Compile(source, name);
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"{expected}\n{expected}\n", RunBounded(assemblyPath, name));
    }

    private static string Compile(string source, string name)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2927NullableSequenceElementTypeTests), name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        Assert.True(exitCode == 0, $"{name}: gsc failed:\n{stdout}\n{stderr}");
        return assemblyPath;
    }

    private static string RunBounded(string assemblyPath, string name)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(30_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        Assert.True(exited, $"{name}: emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{error}");
        return output.Replace("\r\n", "\n");
    }
}

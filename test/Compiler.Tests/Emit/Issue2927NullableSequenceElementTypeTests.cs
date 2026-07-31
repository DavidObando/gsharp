// <copyright file="Issue2927NullableSequenceElementTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
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
    public void ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927ReferenceConstrained
            import System

            func values[T class](value T) sequence[T?] {
                yield value
                yield nil
            }

            for value in values[string]("x") {
                Console.WriteLine(value == nil ? "nil" : value)
            }
            """;

        var assemblyPath = Compile(Source, nameof(ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal("x\nnil\n", RunBounded(assemblyPath, nameof(ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns)));
    }

    [Fact]
    public void StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927StructConstrained
            import System

            func values[T struct](value T) sequence[T?] {
                yield value
                yield nil
            }

            for value in values[int32](5) {
                Console.WriteLine(value == nil ? "nil" : value.ToString())
            }
            """;

        var assemblyPath = Compile(Source, nameof(StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal("5\nnil\n", RunBounded(assemblyPath, nameof(StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns)));
    }

    [Fact]
    public void NullableReferenceSequenceGuardLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927ReferenceGuard
            import System

            func text(value string?) string {
                if value == nil { return "nil" }
                return value
            }

            func values() sequence[string?] {
                yield "x"
                yield nil
            }

            for value in values() { Console.WriteLine(text(value)) }
            """;

        var assemblyPath = Compile(Source, nameof(NullableReferenceSequenceGuardLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal("x\nnil\n", RunBounded(assemblyPath, nameof(NullableReferenceSequenceGuardLoadsVerifiesAndRuns)));
    }

    [Fact]
    public void NullableUserEnumSequenceGuardLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927EnumGuard
            import System

            enum E { A }

            func text(value E?) string {
                if value == nil { return "nil" }
                return value.ToString()
            }

            func values() sequence[E?] {
                yield E.A
                yield nil
            }

            for value in values() { Console.WriteLine(text(value)) }
            """;

        var assemblyPath = Compile(Source, nameof(NullableUserEnumSequenceGuardLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal("A\nnil\n", RunBounded(assemblyPath, nameof(NullableUserEnumSequenceGuardLoadsVerifiesAndRuns)));
    }

    [Theory]
    [InlineData("Direct", """
        for value in values[int32](5) {
            Console.WriteLine(value)
        }
        """)]
    [InlineData("ConcreteParameter", """
        func consume(values sequence[int32?]) {
            for value in values {
                Console.WriteLine(value)
            }
        }

        consume(values[int32](5))
        """)]
    [InlineData("AnnotatedVariable", """
        var concrete sequence[int32?] = values[int32](5)
        for value in concrete {
            Console.WriteLine(value)
        }
        """)]
    [InlineData("PassthroughFunction", """
        func pass(values sequence[int32?]) sequence[int32?] -> values
        for value in pass(values[int32](5)) {
            Console.WriteLine(value)
        }
        """)]
    public void GenericNullableSequenceReportsSingleGS0508(string shape, string usage)
    {
        var source = $$"""
            package Issue2927Generic{{shape}}
            import System

            func values[T](value T) sequence[T?] {
                yield value
                yield nil
            }

            {{usage}}
            """;

        // GS0508 prevents emission, so no assembly exists to load or pass to IlVerifier.
        AssertSingleGS0508(source, $"{nameof(GenericNullableSequenceReportsSingleGS0508)}_{shape}");
    }

    [Fact]
    public void GenericAsyncNullableSequenceReportsSingleGS0508()
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

        // GS0508 prevents emission, so no assembly exists to load or pass to IlVerifier.
        AssertSingleGS0508(Source, nameof(GenericAsyncNullableSequenceReportsSingleGS0508));
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
        var result = InvokeCompiler(source, name);
        Assert.True(result.ExitCode == 0, $"{name}: gsc failed:\n{result.Output}");
        return result.AssemblyPath;
    }

    private static void AssertSingleGS0508(string source, string name)
    {
        var result = InvokeCompiler(source, name);
        Assert.NotEqual(0, result.ExitCode);
        var diagnostics = result.Output.Split('\n')
            .Where(line => line.Contains("error GS", StringComparison.Ordinal))
            .ToArray();
        Assert.Single(diagnostics);
        Assert.Contains("error GS0508:", diagnostics[0], StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath), "gsc must not emit an assembly after GS0508");
    }

    private static (int ExitCode, string Output, string AssemblyPath) InvokeCompiler(string source, string name)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2927NullableSequenceElementTypeTests), name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);
        File.Delete(assemblyPath);
        File.Delete(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));

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

        return (exitCode, stdout.ToString() + stderr.ToString(), assemblyPath);
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

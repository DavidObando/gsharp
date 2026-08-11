// <copyright file="Issue2907IteratorLoopCaptureTests.cs" company="GSharp">
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
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2907: captures created inside iterator loops compile and match
/// equivalent non-iterator capture semantics. Asserts the emitted program
/// only; the interpreter parity arm was retired with the evaluator in
/// ADR-0156 Phase 3c (#3176).
/// </summary>
public class Issue2907IteratorLoopCaptureTests
{
    public static IEnumerable<object[]> CaptureCases()
    {
        yield return BuildCase(
            "EllipsisLoopVariable",
            """
            func values() sequence[int32] {
                for i in 0 ... 3 {
                    var read = () -> { return i }
                    yield read()
                }
            }

            func direct() string {
                var result = ""
                for i in 0 ... 3 {
                    var read = () -> { return i }
                    result = result + read().ToString() + ","
                }

                return result
            }
            """,
            "values()",
            "direct()",
            "0,1,2,");

        yield return BuildCase(
            "CollectionLoopVariable",
            """
            func values() sequence[int32] {
                for value in []int32{4, 5, 6} {
                    var read = () -> { return value }
                    yield read()
                }
            }

            func direct() string {
                var result = ""
                for value in []int32{4, 5, 6} {
                    var read = () -> { return value }
                    result = result + read().ToString() + ","
                }

                return result
            }
            """,
            "values()",
            "direct()",
            "4,5,6,");

        yield return BuildCase(
            "ThreePartLoopVariable",
            """
            func values() sequence[int32] {
                for var i = 0; i < 3; i++ {
                    var read = () -> { return i }
                    yield read()
                }
            }

            func direct() string {
                var result = ""
                for var i = 0; i < 3; i++ {
                    var read = () -> { return i }
                    result = result + read().ToString() + ","
                }

                return result
            }
            """,
            "values()",
            "direct()",
            "0,1,2,");

        yield return BuildCase(
            "LoopBodyLocalNestedAndAfterLoopYield",
            """
            func values() sequence[int32] {
                var read = () -> { return -1 }
                for i in 0 ... 3 {
                    {
                        var local = i + 10
                        read = () -> { return local }
                        if i < 2 {
                            yield read()
                        }
                    }
                }

                yield read()
            }

            func direct() string {
                var result = ""
                var read = () -> { return -1 }
                for i in 0 ... 3 {
                    {
                        var local = i + 10
                        read = () -> { return local }
                        if i < 2 {
                            result = result + read().ToString() + ","
                        }
                    }
                }

                return result + read().ToString() + ","
            }
            """,
            "values()",
            "direct()",
            "10,11,12,");

        yield return BuildCase(
            "NestedLoopsCaptureOuterInnerAndBoth",
            """
            func values() sequence[int32] {
                for outer in 1 ... 3 {
                    for inner in []int32{3, 4} {
                        var readOuter = () -> { return outer }
                        var readInner = () -> { return inner }
                        var readBoth = () -> { return outer + inner }
                        yield readOuter() * 100 + readInner() * 10 + readBoth()
                    }
                }
            }

            func direct() string {
                var result = ""
                for outer in 1 ... 3 {
                    for inner in []int32{3, 4} {
                        var readOuter = () -> { return outer }
                        var readInner = () -> { return inner }
                        var readBoth = () -> { return outer + inner }
                        let value = readOuter() * 100 + readInner() * 10 + readBoth()
                        result = result + value.ToString() + ","
                    }
                }

                return result
            }
            """,
            "values()",
            "direct()",
            "134,145,235,246,");

        yield return BuildCase(
            "CapturedLoopVariableMutation",
            """
            func values() sequence[int32] {
                for i in 0 ... 6 {
                    var bump = () -> { i = i + 1 }
                    bump()
                    yield i
                }
            }

            func direct() string {
                var result = ""
                for i in 0 ... 6 {
                    var bump = () -> { i = i + 1 }
                    bump()
                    result = result + i.ToString() + ","
                }

                return result
            }
            """,
            "values()",
            "direct()",
            "1,3,5,");

        yield return BuildCase(
            "CapturedParameterAndLoopVariable",
            """
            func values(offset int32) sequence[int32] {
                for i in 0 ... 3 {
                    var read = () -> { return offset + i }
                    yield read()
                }
            }

            func direct(offset int32) string {
                var result = ""
                for i in 0 ... 3 {
                    var read = () -> { return offset + i }
                    result = result + read().ToString() + ","
                }

                return result
            }
            """,
            "values(10)",
            "direct(10)",
            "10,11,12,");

        yield return BuildCase(
            "CapturedParameterWithUncapturedLoop",
            """
            func values(n int32) sequence[int32] {
                var read = () -> { return n }
                for i in 0 ... 2 {
                    yield i
                }

                yield read()
            }

            func direct(n int32) string {
                var read = () -> { return n }
                var result = ""
                for i in 0 ... 2 {
                    result = result + i.ToString() + ","
                }

                return result + read().ToString() + ","
            }
            """,
            "values(7)",
            "direct(7)",
            "0,1,7,");

        yield return BuildCase(
            "StoredEllipsisCallbacksAfterLoop",
            """
            func values() sequence[int32] {
                var first = () -> { return -1 }
                var second = () -> { return -1 }
                var third = () -> { return -1 }
                for i in 0 ... 3 {
                    if i == 0 { first = () -> { return i } }
                    if i == 1 { second = () -> { return i } }
                    if i == 2 { third = () -> { return i } }
                }

                yield first()
                yield second()
                yield third()
            }

            func direct() string {
                var first = () -> { return -1 }
                var second = () -> { return -1 }
                var third = () -> { return -1 }
                for i in 0 ... 3 {
                    if i == 0 { first = () -> { return i } }
                    if i == 1 { second = () -> { return i } }
                    if i == 2 { third = () -> { return i } }
                }

                return first().ToString() + "," + second().ToString() + "," + third().ToString() + ","
            }
            """,
            "values()",
            "direct()",
            "0,1,2,");

        yield return BuildCase(
            "StoredCollectionCallbacksAfterLoop",
            """
            func values() sequence[int32] {
                var first = () -> { return -1 }
                var second = () -> { return -1 }
                var third = () -> { return -1 }
                for value in []int32{4, 5, 6} {
                    if value == 4 { first = () -> { return value } }
                    if value == 5 { second = () -> { return value } }
                    if value == 6 { third = () -> { return value } }
                }

                yield first()
                yield second()
                yield third()
            }

            func direct() string {
                var first = () -> { return -1 }
                var second = () -> { return -1 }
                var third = () -> { return -1 }
                for value in []int32{4, 5, 6} {
                    if value == 4 { first = () -> { return value } }
                    if value == 5 { second = () -> { return value } }
                    if value == 6 { third = () -> { return value } }
                }

                return first().ToString() + "," + second().ToString() + "," + third().ToString() + ","
            }
            """,
            "values()",
            "direct()",
            "4,5,6,");

        yield return BuildCase(
            "StoredThreePartCallbacksAfterLoop",
            """
            func values() sequence[int32] {
                var first = () -> { return -1 }
                var second = () -> { return -1 }
                var third = () -> { return -1 }
                for var i = 0; i < 3; i++ {
                    if i == 0 { first = () -> { return i } }
                    if i == 1 { second = () -> { return i } }
                    if i == 2 { third = () -> { return i } }
                }

                yield first()
                yield second()
                yield third()
            }

            func direct() string {
                var first = () -> { return -1 }
                var second = () -> { return -1 }
                var third = () -> { return -1 }
                for var i = 0; i < 3; i++ {
                    if i == 0 { first = () -> { return i } }
                    if i == 1 { second = () -> { return i } }
                    if i == 2 { third = () -> { return i } }
                }

                return first().ToString() + "," + second().ToString() + "," + third().ToString() + ","
            }
            """,
            "values()",
            "direct()",
            "3,3,3,");

        yield return BuildCase(
            "GenericFunctionValueAndReferenceTypes",
            """
            func values[T any](items []T) sequence[T] {
                for value in items {
                    var read = () -> { return value }
                    yield read()
                }
            }

            func direct[T any](items []T) string {
                var result = ""
                for value in items {
                    var read = () -> { return value }
                    result = result + read().ToString() + ","
                }

                return result
            }

            func allValues() sequence[string] {
                for value in values[int32]([]int32{1, 2}) {
                    yield value.ToString()
                }

                for value in values[string]([]string{"a", "b"}) {
                    yield value
                }
            }

            func allDirect() string {
                return direct[int32]([]int32{1, 2}) + direct[string]([]string{"a", "b"})
            }
            """,
            "allValues()",
            "allDirect()",
            "1,2,a,b,");

        yield return BuildCase(
            "GenericTypeIterator",
            """
            class Bucket[T any] {
                func values(items []T) sequence[T] {
                    for value in items {
                        var read = () -> { return value }
                        yield read()
                    }
                }

                func direct(items []T) string {
                    var result = ""
                    for value in items {
                        var read = () -> { return value }
                        result = result + read().ToString() + ","
                    }

                    return result
                }
            }

            func allValues() sequence[string] {
                let bucket = Bucket[string]()
                for value in bucket.values([]string{"x", "y"}) {
                    yield value
                }
            }

            func allDirect() string {
                let bucket = Bucket[string]()
                return bucket.direct([]string{"x", "y"})
            }
            """,
            "allValues()",
            "allDirect()",
            "x,y,");

        yield return BuildCase(
            "WhileLoopBodyLocal",
            """
            func values() sequence[int32] {
                var i = 0
                while i < 3 {
                    var local = i
                    var read = () -> { return local }
                    yield read()
                    i++
                }
            }

            func direct() string {
                var result = ""
                var i = 0
                while i < 3 {
                    var local = i
                    var read = () -> { return local }
                    result = result + read().ToString() + ","
                    i++
                }

                return result
            }
            """,
            "values()",
            "direct()",
            "0,1,2,");

        yield return BuildCase(
            "DoLoopBodyLocal",
            """
            func values() sequence[int32] {
                var i = 0
                do {
                    var local = i
                    var read = () -> { return local }
                    yield read()
                    i++
                } while i < 3
            }

            func direct() string {
                var result = ""
                var i = 0
                do {
                    var local = i
                    var read = () -> { return local }
                    result = result + read().ToString() + ","
                    i++
                } while i < 3

                return result
            }
            """,
            "values()",
            "direct()",
            "0,1,2,");

        yield return BuildCase(
            "IteratorLoopWithoutCaptureGuard",
            """
            func values() sequence[int32] {
                for i in 0 ... 3 {
                    yield i
                }
            }

            func direct() string {
                return "0,1,2,"
            }
            """,
            "values()",
            "direct()",
            "0,1,2,");

        yield return BuildCase(
            "IteratorWithoutLoopGuard",
            """
            func values() sequence[int32] {
                yield 1
                yield 2
            }

            func direct() string {
                return "1,2,"
            }
            """,
            "values()",
            "direct()",
            "1,2,");
    }

    [Theory]
    [MemberData(nameof(CaptureCases))]
    public void IteratorAndNonIteratorCaptureSemanticsAgree(
        string name,
        string source,
        string expected)
    {
        var assemblyPath = Compile(source, name);
        IlVerifier.Verify(assemblyPath);

        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());

        var output = RunBounded(assemblyPath, name);
        Assert.Equal($"{expected}{Environment.NewLine}{expected}{Environment.NewLine}", output);
    }

    [Fact]
    public void AsyncIteratorLoopCaptureAgreesWithNonIterator()
    {
        const string Source = """
            package Issue2907Async
            import System
            import System.Threading.Tasks

            async func values() async sequence[int32] {
                for i in 0 ... 3 {
                    var read = () -> { return i }
                    yield read()
                    await Task.Delay(1)
                }
            }

            func direct() string {
                var result = ""
                for i in 0 ... 3 {
                    var read = () -> { return i }
                    result = result + read().ToString() + ","
                }

                return result
            }

            public var iteratorResult = ""

            async func collect() {
                await for value in values() {
                    iteratorResult = iteratorResult + value.ToString() + ","
                }
            }

            collect().Wait()
            let directResult = direct()
            Console.WriteLine(iteratorResult)
            Console.WriteLine(directResult)
            iteratorResult == directResult
            """;

        AssertParity(Source, "0,1,2,", nameof(AsyncIteratorLoopCaptureAgreesWithNonIterator));
    }

    [Fact]
    public async Task LibraryIteratorLoopCaptureLoadsAndInvokes()
    {
        const string Source = """
            package Issue2907Library

            public func values() sequence[int32] {
                for i in 0 ... 2 {
                    var read = () -> { return i }
                    yield read()
                }
            }
            """;

        var assemblyPath = Compile(Source, nameof(LibraryIteratorLoopCaptureLoadsAndInvokes), target: "library");
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var method = program.GetMethod("values", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(method);

        var values = await Task.Run(() => ((System.Collections.IEnumerable)method.Invoke(null, null))
            .Cast<object>()
            .Select(Convert.ToInt32)
            .ToArray()).WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(new[] { 0, 1 }, values);
    }

    [Fact]
    public void NonIteratorLoopCaptureGuard()
    {
        const string Source = """
            package Issue2907NonIteratorGuard
            import System

            func direct() string {
                var first = () -> { return -1 }
                var second = () -> { return -1 }
                for i in 0 ... 2 {
                    if i == 0 { first = () -> { return i } }
                    if i == 1 { second = () -> { return i } }
                }

                return first().ToString() + "," + second().ToString() + ","
            }

            Console.WriteLine(direct())
            """;

        var assemblyPath = Compile(Source, nameof(NonIteratorLoopCaptureGuard));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"0,1,{Environment.NewLine}", RunBounded(assemblyPath, nameof(NonIteratorLoopCaptureGuard)));
    }

    private static object[] BuildCase(
        string name,
        string declarations,
        string iteratorCall,
        string directCall,
        string expected)
    {
        var source = $$"""
            package Issue2907{{name}}
            import System

            {{declarations}}

            var iteratorResult = ""
            for value in {{iteratorCall}} {
                iteratorResult = iteratorResult + value.ToString() + ","
            }

            let directResult = {{directCall}}
            Console.WriteLine(iteratorResult)
            Console.WriteLine(directResult)
            iteratorResult == directResult
            """;

        return new object[] { name, source, expected };
    }

    private static void AssertParity(string source, string expected, string name)
    {
        var assemblyPath = Compile(source, name);
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"{expected}{Environment.NewLine}{expected}{Environment.NewLine}", RunBounded(assemblyPath, name));
    }

    private static string Compile(string source, string name, string target = "exe")
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2907IteratorLoopCaptureTests), name);
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
                "/target:" + target,
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
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}

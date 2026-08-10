// <copyright file="Issue2951NestedGenericStructIteratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2951 and #1537 residual: nested generic state machines and method
/// references retain every enclosing and receiver type-parameter ordinal.
/// </summary>
public class Issue2951NestedGenericStructIteratorTests
{
    [Fact]
    public void NestedNonGenericStructUsesEnclosingTypeParameter()
    {
        const string Source = """
            package Issue2951Enclosing
            import System

            class Wrap[T] {
                struct Cell {
                    var A T
                    func vals() sequence[T] { yield A }
                }
            }

            for value in Wrap[int32].Cell{A: 42}.vals() {
                Console.WriteLine(value)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(NestedNonGenericStructUsesEnclosingTypeParameter), "42\n");
    }

    [Fact]
    public void NestedGenericStructUsesOwnTypeParameterDirectlyAndInLoop()
    {
        const string Source = """
            package Issue2951Own
            import System

            class Wrap[T] {
                struct Cell[U] {
                    var A U
                    func vals() sequence[U] { yield A }
                }
            }

            var cell = Wrap[int32].Cell[string]{A: "x"}
            let iterator = cell.vals().GetEnumerator()
            if iterator.MoveNext() {
                Console.WriteLine(iterator.Current)
            }

            for value in cell.vals() {
                Console.WriteLine(value)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(NestedGenericStructUsesOwnTypeParameterDirectlyAndInLoop), "x\nx\n");
    }

    [Fact]
    public void NestedGenericStructUsesBothParametersAtTwoInstantiations()
    {
        const string Source = """
            package Issue2951Both
            import System

            class Outer[T] {
                struct Cell[U] {
                    var A T
                    var B U
                    func vals() sequence[string] { yield A.ToString() + B.ToString() }
                }
            }

            var first = Outer[int32].Cell[string]{A: 42, B: "x"}
            for value in first.vals() {
                Console.WriteLine(value)
            }

            var second = Outer[string].Cell[int32]{A: "y", B: 7}
            for value in second.vals() {
                Console.WriteLine(value)
            }
            """;

        AssertLoadsAndRuns(
            Source,
            nameof(NestedGenericStructUsesBothParametersAtTwoInstantiations),
            "42x\ny7\n");
    }

    [Fact]
    public void TwoNestedGenericLevelsUseAllParameters()
    {
        const string Source = """
            package Issue2951TwoLevels
            import System

            class Outer[T] {
                struct Middle[U] {
                    struct Inner[V] {
                        var A T
                        var B U
                        var C V
                        func vals() sequence[string] {
                            yield A.ToString() + B.ToString() + C.ToString()
                        }
                    }
                }
            }

            var value = Outer[int32].Middle[string].Inner[bool]{
                A: 4,
                B: "z",
                C: true
            }
            for item in value.vals() {
                Console.WriteLine(item)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(TwoNestedGenericLevelsUseAllParameters), "4zTrue\n");
    }

    [Fact]
    public void NonGenericOuterLevelDoesNotShiftGenericMiddleParameter()
    {
        const string Source = """
            package Issue2951AsymmetricOuter
            import System

            class Outer {
                struct Mid[U] {
                    struct Inner {
                        var Value U
                        func vals() sequence[U] { yield Value }
                    }
                }
            }

            var value = Outer.Mid[string].Inner{Value: "q"}
            for item in value.vals() {
                Console.WriteLine(item)
            }
            """;

        AssertLoadsAndRuns(
            Source,
            nameof(NonGenericOuterLevelDoesNotShiftGenericMiddleParameter),
            "q\n");
    }

    [Fact]
    public void NonGenericClassMiddleDoesNotShiftOuterAndInnerParameters()
    {
        const string Source = """
            package Issue2951AsymmetricClassMiddle
            import System

            class Outer[T] {
                class Mid {
                    struct Inner[V] {
                        var A T
                        var B V
                        func vals() sequence[string] {
                            yield A.ToString() + "|" + B.ToString()
                        }
                    }
                }
            }

            var value = Outer[int32].Mid.Inner[string]{A: 7, B: "z"}
            for item in value.vals() {
                Console.WriteLine(item)
            }
            """;

        AssertLoadsAndRuns(
            Source,
            nameof(NonGenericClassMiddleDoesNotShiftOuterAndInnerParameters),
            "7|z\n");
    }

    [Fact]
    public void NonGenericStructMiddleDoesNotShiftOuterAndInnerParameters()
    {
        const string Source = """
            package Issue2951AsymmetricStructMiddle
            import System

            class Outer[T] {
                struct Mid {
                    struct Inner[V] {
                        var A T
                        var B V
                        func vals() sequence[string] {
                            yield A.ToString() + "|" + B.ToString()
                        }
                    }
                }
            }

            var value = Outer[bool].Mid.Inner[int32]{A: true, B: 5}
            for item in value.vals() {
                Console.WriteLine(item)
            }
            """;

        AssertLoadsAndRuns(
            Source,
            nameof(NonGenericStructMiddleDoesNotShiftOuterAndInnerParameters),
            "True|5\n");
    }

    [Fact]
    public void NonGenericOuterDoesNotShiftTwoNestedOwnParameters()
    {
        const string Source = """
            package Issue2951AsymmetricOwnParameters
            import System

            class Outer {
                class Mid[U] {
                    struct Inner[V] {
                        var A U
                        var B V
                        func vals() sequence[string] {
                            yield A.ToString() + "|" + B.ToString()
                        }
                    }
                }
            }

            var value = Outer.Mid[string].Inner[int32]{A: "k", B: 9}
            for item in value.vals() {
                Console.WriteLine(item)
            }
            """;

        AssertLoadsAndRuns(
            Source,
            nameof(NonGenericOuterDoesNotShiftTwoNestedOwnParameters),
            "k|9\n");
    }

    [Fact]
    public void AsyncNonGenericMiddleDoesNotShiftOuterAndInnerParameters()
    {
        const string Source = """
            package Issue2951AsymmetricAsync
            import System
            import System.Threading.Tasks

            class Outer[T] {
                class Mid {
                    struct Inner[V] {
                        var A T
                        var B V
                        async func vals() async sequence[string] {
                            yield A.ToString() + "|" + B.ToString()
                            await Task.Delay(1)
                        }
                    }
                }
            }

            var value = Outer[int32].Mid.Inner[string]{A: 3, B: "w"}
            let iterator = value.vals().GetAsyncEnumerator()
            for iterator.MoveNextAsync().AsTask().Result {
                Console.WriteLine(iterator.Current)
            }
            """;

        AssertLoadsAndRuns(
            Source,
            nameof(AsyncNonGenericMiddleDoesNotShiftOuterAndInnerParameters),
            "3|w\n");
    }

    [Fact]
    public void NestedClassIteratorUsesEnclosingTypeParameter()
    {
        const string Source = """
            package Issue2951Class
            import System

            class Outer[T](Seed T) {
                class Cell(Value T) {
                    func vals() sequence[T] { yield Value }
                }

                func print() {
                    for value in Cell(Seed).vals() {
                        Console.WriteLine(value)
                    }
                }
            }

            Outer[int32](43).print()
            """;

        AssertLoadsAndRuns(Source, nameof(NestedClassIteratorUsesEnclosingTypeParameter), "43\n");
    }

    [Fact]
    public void AsyncNestedGenericStructIteratorUsesBothParameters()
    {
        const string Source = """
            package Issue2951Async
            import System
            import System.Threading.Tasks

            class Outer[T] {
                struct Cell[U] {
                    var A T
                    var B U
                    async func vals() async sequence[string] {
                        yield A.ToString() + B.ToString()
                        await Task.Delay(1)
                    }
                }
            }

            var cell = Outer[int32].Cell[string]{A: 44, B: "a"}
            let iterator = cell.vals().GetAsyncEnumerator()
            for iterator.MoveNextAsync().AsTask().Result {
                Console.WriteLine(iterator.Current)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(AsyncNestedGenericStructIteratorUsesBothParameters), "44a\n");
    }

    [Fact]
    public void NestedIteratorComposesWithNullableGenericSpecialization()
    {
        const string Source = """
            package Issue2951Nullable
            import System

            class Outer[T] {
                struct Cell {
                    var Marker T
                    func vals[U](value U) sequence[U?] {
                        Console.WriteLine(Marker)
                        yield value
                        yield nil
                    }
                }
            }

            var cell = Outer[int32].Cell{Marker: 45}
            for value in cell.vals[int32](46) {
                Console.WriteLine(value == nil ? "int:nil" : value.ToString())
            }
            for value in cell.vals[string]("s") {
                Console.WriteLine(value == nil ? "string:nil" : value)
            }
            """;

        AssertLoadsAndRuns(
            Source,
            nameof(NestedIteratorComposesWithNullableGenericSpecialization),
            "45\n46\nint:nil\n45\ns\nstring:nil\n");
    }

    [Fact]
    public void SharedNestedGenericStructIteratorUsesOwnTypeParameter()
    {
        const string Source = """
            package Issue2951Shared
            import System

            class Outer[T] {
                struct Cell[U] {
                    shared {
                        func vals(value U) sequence[U] { yield value }
                    }
                }
            }

            for value in Outer[int32].Cell[string].vals("shared") {
                Console.WriteLine(value)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(SharedNestedGenericStructIteratorUsesOwnTypeParameter), "shared\n");
    }

    [Fact]
    public void NestedGenericNonIteratorMethodUsesDistinctParameterOrdinals()
    {
        const string Source = """
            package Issue2951MethodMemberRef
            import System

            class Outer[T] {
                struct Cell[U] {
                    var A T
                    var B U
                    func echo(u U, t T) string {
                        return u.ToString() + "/" + t.ToString()
                    }
                }
            }

            var value = Outer[int32].Cell[string]{A: 1, B: "b"}
            Console.WriteLine(value.echo("z", 9))
            """;

        AssertLoadsAndRuns(
            Source,
            nameof(NestedGenericNonIteratorMethodUsesDistinctParameterOrdinals),
            "z/9\n");
    }

    [Fact]
    public void NestedEnumIteratorRemainsValid()
    {
        const string Source = """
            package Issue2951EnumGuard
            import System

            class Outer[T] {
                enum Kind { A }
                func vals() sequence[Kind] { yield Kind.A }
            }

            var outer = Outer[int32]()
            for value in outer.vals() {
                Console.WriteLine(value)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(NestedEnumIteratorRemainsValid), "0\n");
    }

    [Fact]
    public void TopLevelGenericStructIteratorRemainsValid()
    {
        const string Source = """
            package Issue2951TopLevelGuard
            import System

            struct Cell[T] {
                var A T
                func vals() sequence[T] { yield A }
            }

            var cell = Cell[int32]{A: 45}
            for value in cell.vals() {
                Console.WriteLine(value)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(TopLevelGenericStructIteratorRemainsValid), "45\n");
    }

    [Fact]
    public void NonGenericNestedStructIteratorRemainsValid()
    {
        const string Source = """
            package Issue2951NonGenericGuard
            import System

            class Outer {
                struct Cell {
                    var A int32
                    func vals() sequence[int32] { yield A }
                }
            }

            for value in Outer.Cell{A: 46}.vals() {
                Console.WriteLine(value)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(NonGenericNestedStructIteratorRemainsValid), "46\n");
    }

    [Fact]
    public void TopLevelFunctionIteratorRemainsValid()
    {
        const string Source = """
            package Issue2951FunctionGuard
            import System

            func vals() sequence[int32] { yield 47 }

            for value in vals() {
                Console.WriteLine(value)
            }
            """;

        AssertLoadsAndRuns(Source, nameof(TopLevelFunctionIteratorRemainsValid), "47\n");
    }

    private static void AssertLoadsAndRuns(string source, string name, string expected)
    {
        var assemblyPath = Compile(source, name);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal(expected, RunBounded(assemblyPath, name));
    }

    private static string Compile(string source, string name)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2951NestedGenericStructIteratorTests),
            name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, name + ".dll");
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

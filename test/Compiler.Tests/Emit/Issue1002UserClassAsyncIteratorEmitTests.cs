// <copyright file="Issue1002UserClassAsyncIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1002 (parallel to #990) — emit + IL-verify + run coverage for
/// <em>async</em> iterators whose element type is a user-declared
/// reference type (e.g. <c>IAsyncEnumerable[Shape]</c> where
/// <c>Shape</c> is a user class).
/// <para>Before the fix the state machine's
/// <c>IAsyncEnumerable&lt;T&gt;</c> / <c>IAsyncEnumerator&lt;T&gt;</c>
/// interface rows and the <c>GetAsyncEnumerator</c> return signature
/// erased the user element type to <c>object</c> via
/// <c>elementType.ClrType ?? typeof(object)</c>, producing
/// generic-invariance-invalid IL: an <c>async func shapes() IAsyncEnumerable[Shape]</c>
/// kickoff returned a value whose runtime type only implemented
/// <c>IAsyncEnumerable&lt;object&gt;</c> (ilverify
/// <c>StackUnexpected: found ref '...d__1' expected ref 'IAsyncEnumerable`1&lt;T.Shape&gt;'</c>).</para>
/// <para>The consumer side (<c>await for s in shapes()</c>) suffered a
/// parallel erasure: the await-for lowering read <c>Current</c> off the
/// closed <c>IAsyncEnumerator&lt;object&gt;</c> shape, which yielded an
/// <c>object</c> assigned into the strongly-typed <c>Shape</c> loop slot
/// — also rejected by ilverify even though the reference was correct at
/// runtime.</para>
/// </summary>
public class Issue1002UserClassAsyncIteratorEmitTests
{
    [Fact]
    public void UserReferenceTypeAsyncIterator_Compiles_And_IlVerifies()
    {
        var source = """
            package T
            import System.Collections.Generic
            import System.Threading.Tasks
            open class Shape { }
            async func shapes() IAsyncEnumerable[Shape] {
                yield Shape()
                await Task.Delay(1)
                yield Shape()
            }
            """;

        // CompileToFile asserts gsc exit 0 and runs ilverify.
        CompileToFile(source, target: "library");
    }

    [Fact]
    public void UserReferenceTypeAsyncIterator_EndToEnd_PrintsShapeTwice()
    {
        var source = """
            package T
            import System
            import System.Collections.Generic
            import System.Threading.Tasks
            open class Shape { func Tag() string { return "shape" } }
            async func shapes() IAsyncEnumerable[Shape] {
                yield Shape()
                await Task.Delay(1)
                yield Shape()
            }
            async func Run() {
                let seq = shapes()
                await for s in seq {
                    Console.WriteLine(s.Tag())
                }
            }
            Run().Wait()
            """;

        var output = CompileRunAndCaptureOutput(source);

        var lines = output.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');
        Assert.Equal(new[] { "shape", "shape" }, lines);
    }

    [Fact]
    public void UserReferenceTypeAsyncIterator_AccumulatesValues()
    {
        var source = """
            package T
            import System.Collections.Generic
            import System.Threading.Tasks
            open class Box { var value int32 = 0 }
            async func boxes() IAsyncEnumerable[Box] {
                var a = Box()
                a.value = 10
                yield a
                await Task.Delay(1)
                var b = Box()
                b.value = 20
                yield b
                await Task.Delay(1)
                var c = Box()
                c.value = 30
                yield c
            }
            public var total = 0
            async func Run() {
                await for b in boxes() {
                    total = total + b.value
                }
            }
            Run().Wait()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(60, GetIntField(assembly, "total"));
    }

    [Fact]
    public void UserValueStructAsyncIterator_AccumulatesCorrectly()
    {
        var source = """
            package T
            import System.Collections.Generic
            import System.Threading.Tasks
            data struct Point { var x int32 }
            async func points() IAsyncEnumerable[Point] {
                yield Point{x: 1}
                await Task.Delay(1)
                yield Point{x: 2}
                await Task.Delay(1)
                yield Point{x: 3}
            }
            public var total = 0
            async func Run() {
                await for p in points() {
                    total = total + p.x
                }
            }
            Run().Wait()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(6, GetIntField(assembly, "total"));
    }

    [Fact]
    public void BclInt32AsyncElementControl_StillCompilesAndRuns()
    {
        var source = """
            package T
            import System.Collections.Generic
            import System.Threading.Tasks
            async func nums() IAsyncEnumerable[int32] {
                yield 1
                await Task.Delay(1)
                yield 2
            }
            public var sum = 0
            async func Run() {
                await for n in nums() {
                    sum = sum + n
                }
            }
            Run().Wait()
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(3, GetIntField(assembly, "sum"));
    }

    private static Assembly CompileAndRun(string source)
    {
        var outPath = CompileToFile(source, target: "exe");
        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static string CompileRunAndCaptureOutput(string source)
    {
        var outPath = CompileToFile(source, target: "exe");
        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

        using var captured = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(captured);
        try
        {
            entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return captured.ToString();
    }

    private static string CompileToFile(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1002_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static int GetIntField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (int)field!.GetValue(null)!;
    }
}

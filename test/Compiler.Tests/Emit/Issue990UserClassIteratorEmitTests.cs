// <copyright file="Issue990UserClassIteratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #990 — emit + IL-verify + run coverage for generators whose
/// element type is a user-declared reference type (e.g.
/// <c>sequence[Shape]</c> where <c>Shape</c> is a user class).
/// <para>The crash was a GS9998 ICE: "Conversion from 'Shape' to 'object'
/// is not yet supported by the emitter". The synthesized non-generic
/// <c>IEnumerator.Current</c> property converts the strongly-typed
/// <c>&lt;&gt;2__current</c> field to <c>object</c>; a user class has no
/// ClrType during emit, so <c>IsReferenceCompatible</c> failed to
/// recognise the reference widening as a no-op.</para>
/// </summary>
public class Issue990UserClassIteratorEmitTests
{
    [Fact]
    public void UserReferenceTypeGenerator_Compiles_And_IlVerifies()
    {
        var source = """
            package T
            open class Shape { }
            func shapes() sequence[Shape] { yield Shape() }
            """;

        // CompileToFile asserts gsc exit 0 and runs ilverify.
        CompileToFile(source, target: "library");
    }

    [Fact]
    public void UserReferenceTypeGenerator_EndToEnd_PrintsShapeTwice()
    {
        var source = """
            package T
            import System
            open class Shape { func Tag() string { return "shape" } }
            func shapes() sequence[Shape] {
                yield Shape()
                yield Shape()
            }
            for s in shapes() { Console.WriteLine(s.Tag()) }
            """;

        var output = CompileRunAndCaptureOutput(source);

        var lines = output.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');
        Assert.Equal(new[] { "shape", "shape" }, lines);
    }

    [Fact]
    public void UserReferenceTypeGenerator_AccumulatesMultipleInstances()
    {
        var source = """
            package T
            open class Box { var value int32 = 0 }
            func boxes() sequence[Box] {
                var a = Box()
                a.value = 10
                yield a
                var b = Box()
                b.value = 20
                yield b
                var c = Box()
                c.value = 30
                yield c
            }
            public var total = 0
            for b in boxes() { total = total + b.value }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(60, GetIntField(assembly, "total"));
    }

    [Fact]
    public void UserValueStructGenerator_AccumulatesCorrectly()
    {
        var source = """
            package T
            data struct Point { var x int32 }
            func points() sequence[Point] {
                yield Point{x: 1}
                yield Point{x: 2}
                yield Point{x: 3}
            }
            public var total = 0
            for p in points() { total = total + p.x }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(6, GetIntField(assembly, "total"));
    }

    [Fact]
    public void BclStringElementControl_StillCompilesAndRuns()
    {
        var source = """
            package T
            func names() sequence[string] { yield "a" }
            public var count = 0
            for n in names() { count = count + 1 }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(1, GetIntField(assembly, "count"));
    }

    [Fact]
    public void BclInt32ElementControl_StillCompilesAndRuns()
    {
        var source = """
            package T
            func nums() sequence[int32] { yield 1 }
            public var sum = 0
            for n in nums() { sum = sum + n }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(1, GetIntField(assembly, "sum"));
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
        var tempDir = Directory.CreateTempSubdirectory("gs_990_").FullName;
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

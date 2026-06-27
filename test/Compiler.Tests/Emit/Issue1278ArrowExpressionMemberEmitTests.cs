// <copyright file="Issue1278ArrowExpressionMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1278 / ADR-0131: emit + run coverage for expression-bodied members
/// using the G# arrow <c>-&gt;</c>. Each program declares an arrow-bodied
/// member (function/method, read-only property, get/set accessors, indexer,
/// operator, or conversion operator), runs it, and reads back an
/// <c>int32 result</c> field, proving the desugared bodies emit and execute
/// identically to their block-bodied equivalents.
/// </summary>
public class Issue1278ArrowExpressionMemberEmitTests
{
    [Fact]
    public void FunctionArrowBody_RunsAndReturns()
    {
        var source = """
            package P

            func square(x int32) int32 -> x * x

            public var result = square(9)
            """;

        Assert.Equal(81, RunAndGetIntResult(source));
    }

    [Fact]
    public void VoidMethodArrowBody_ExecutesSideEffect()
    {
        // A void method expression body is an executed statement (a call that
        // writes a field), proving the `{ expr }` desugar runs.
        var source = """
            package P

            class Counter {
                var n int32
                func Bump() -> this.Add(5)
                func Add(d int32) -> this.Set(this.n + d)
                func Set(v int32) -> this.Store(v)
                func Store(v int32) { this.n = v }
            }

            let c = Counter()
            c.Bump()
            c.Bump()
            public var result = c.n
            """;

        Assert.Equal(10, RunAndGetIntResult(source));
    }

    [Fact]
    public void ReadOnlyPropertyArrow_RunsAndReturns()
    {
        var source = """
            package P

            class Box {
                var seed int32
                prop Doubled int32 -> this.seed * 2
            }

            let b = Box()
            b.seed = 21
            public var result = b.Doubled
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    [Fact]
    public void AccessorArrows_RoundTripThroughField()
    {
        var source = """
            package P

            class Box {
                var n int32
                prop Value int32 {
                    get -> this.n
                    set -> this.n = value
                }
            }

            let b = Box()
            b.Value = 33
            public var result = b.Value
            """;

        Assert.Equal(33, RunAndGetIntResult(source));
    }

    [Fact]
    public void IndexerArrow_RunsAndReturns()
    {
        var source = """
            package P

            class Grid {
                var data []int32
                prop this[i int32] int32 -> this.data[i]
            }

            let g = Grid{data: []int32{10, 20, 30}}
            public var result = g[2]
            """;

        Assert.Equal(30, RunAndGetIntResult(source));
    }

    [Fact]
    public void OperatorArrow_RunsAndReturns()
    {
        var source = """
            package P

            struct V {
                var x int32
            }

            func (a V) operator +(b V) V -> V{x: a.x + b.x}

            let s = V{x: 4} + V{x: 38}
            public var result = s.x
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    [Fact]
    public void ConversionOperatorArrow_RunsAndReturns()
    {
        var source = """
            package P

            struct Celsius {
                var degrees int32
            }

            func operator implicit (c Celsius) int32 -> c.degrees

            let c = Celsius{degrees: 99}
            var d int32 = c
            public var result = d
            """;

        Assert.Equal(99, RunAndGetIntResult(source));
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(
            "result",
            BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
        return (int)resultField!.GetValue(null)!;
    }

    private static Assembly CompileToAssembly(string source)
    {
        var (exitCode, output, outPath) = CompileToFile(source);
        Assert.True(exitCode == 0, $"gsc failed:\n{output}");
        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }

    private static (int ExitCode, string Output, string OutPath) CompileToFile(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1278_emit_").FullName;
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
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        var output = compileOut.ToString() + compileErr.ToString();
        return (compileExit, output, outPath);
    }
}

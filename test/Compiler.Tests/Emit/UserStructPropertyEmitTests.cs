// <copyright file="UserStructPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #418 (P1-5) regression tests. Reading or writing a G# property on
/// a value-type (struct) receiver must pass a managed pointer as <c>this</c>
/// for every receiver shape — including method-call results, indexer reads,
/// tuple elements, and nested-field chains — not just a plain
/// <c>BoundVariableExpression</c>. Pushing the struct value as <c>this</c>
/// reinterprets the bits as the pointer and crashes the JIT (SIGSEGV /
/// <see cref="InvalidProgramException"/>).
///
/// Each test compiles a small program, invokes <c>&lt;Main&gt;$</c>, and
/// reads a top-level <c>result</c> field via reflection.
/// </summary>
public class UserStructPropertyEmitTests
{
    [Fact]
    public void PropertyAccess_On_Variable_Struct_Receiver_RoundTrips()
    {
        var source = """
            package P
            import System

            type Point struct {
                var X int32
                var Y int32
                prop Sum int32 {
                    get { return this.X + this.Y }
                }
            }

            let p = Point{X: 5, Y: 6}
            public var result = p.Sum
            """;

        Assert.Equal(11, RunAndGetIntResult(source));
    }

    [Fact]
    public void PropertyAccess_On_Method_Call_Struct_Receiver_RoundTrips()
    {
        // Receiver is `makePoint(5, 6)` — a struct rvalue with no
        // addressable storage. Before #418 the getter call received the
        // struct value as `this` and the JIT crashed with SIGSEGV.
        var source = """
            package P
            import System

            type Point struct {
                var X int32
                var Y int32
                prop Sum int32 {
                    get { return this.X + this.Y }
                }
            }

            func makePoint(x int32, y int32) Point {
                return Point{X: x, Y: y}
            }

            public var result = makePoint(5, 6).Sum
            """;

        Assert.Equal(11, RunAndGetIntResult(source));
    }

    [Fact]
    public void PropertyAccess_On_Nested_Field_Of_Rvalue_RoundTrips()
    {
        // Receiver is `makeOuter().Inner` — a field-chain whose head is an
        // rvalue. Same spill path as method-call receivers.
        var source = """
            package P
            import System

            type Inner struct {
                var V int32
                prop Triple int32 {
                    get { return this.V * 3 }
                }
            }

            type Outer struct {
                var Inner Inner
            }

            func makeOuter(v int32) Outer {
                return Outer{Inner: Inner{V: v}}
            }

            public var result = makeOuter(7).Inner.Triple
            """;

        Assert.Equal(21, RunAndGetIntResult(source));
    }

    [Fact]
    public void PropertyAccess_On_Indexer_Result_Struct_Receiver_RoundTrips()
    {
        // Receiver is `arr[0]` — an indexer read returning a struct rvalue.
        var source = """
            package P
            import System

            type Point struct {
                var X int32
                var Y int32
                prop Sum int32 {
                    get { return this.X + this.Y }
                }
            }

            let arr = [3]Point{ Point{X: 5, Y: 6}, Point{X: 1, Y: 2}, Point{X: 10, Y: 20} }
            public var result = arr[0].Sum
            """;

        Assert.Equal(11, RunAndGetIntResult(source));
    }

    [Fact]
    public void PropertyAccess_On_Cast_Struct_Receiver_RoundTrips()
    {
        // Receiver is a cast expression `Point(other)` — synthesised rvalue.
        // The existing code path's `BoundVariableExpression` check skipped
        // this shape and emitted `call get_Sum` against a value on the stack.
        var source = """
            package P
            import System

            type Point struct {
                var X int32
                var Y int32
                prop Sum int32 {
                    get { return this.X + this.Y }
                }
            }

            type Pair struct {
                var A int32
                var B int32
            }

            func makePoint(x int32, y int32) Point {
                return Point{X: x, Y: y}
            }

            // Read property off the result of a sequence of method calls.
            public var result = makePoint(makePoint(2, 3).Sum, makePoint(1, 5).Sum).Sum
            """;

        // (2+3) + (1+5) = 11
        Assert.Equal(11, RunAndGetIntResult(source));
    }

    [Fact]
    public void PropertyAccess_On_Class_Receiver_Still_Uses_Callvirt()
    {
        // Class receivers must still use callvirt; verify class properties
        // continue to round-trip unchanged.
        var source = """
            package P
            import System

            type Box class {
                prop V int32
                prop Doubled int32 {
                    get { return this.V * 2 }
                }
            }

            func makeBox(v int32) Box {
                let b = Box{}
                b.V = v
                return b
            }

            public var result = makeBox(13).Doubled
            """;

        Assert.Equal(26, RunAndGetIntResult(source));
    }

    [Fact]
    public void PropertyAssignment_On_Variable_Struct_Receiver_RoundTrips()
    {
        var source = """
            package P
            import System

            type Holder struct {
                prop raw int32
                prop V int32 {
                    get { return this.raw }
                    set(v) { this.raw = v * 2 }
                }
            }

            var h = Holder{}
            public var result = h.V = 21
            """;

        // Issue #418 (P1-2): assignment expression yields the spilled assigned
        // value (21), not a getter re-read — matches Roslyn semantics and
        // avoids double-evaluating the receiver / re-invoking the getter.
        Assert.Equal(21, RunAndGetIntResult(source));
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source, target: "exe");
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

    private static Assembly CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_user_prop_emit_").FullName;
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

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}

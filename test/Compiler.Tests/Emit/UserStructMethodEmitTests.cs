// <copyright file="UserStructMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #409 regression tests. A receiver clause
/// <c>func (p Point) Distance() int32</c> on a same-package user-defined
/// struct binds as an instance method on a value type (Phase 6.4). The
/// emitter must pass a managed pointer as <c>this</c> for every receiver
/// shape the call site can take; pushing the struct value directly
/// reinterprets the bits as the <c>this</c> pointer and corrupts the stack
/// (SIGSEGV, or <see cref="InvalidProgramException"/> at JIT time).
///
/// Each test compiles a small program that writes the call's result into a
/// top-level global, invokes <c>&lt;Main&gt;$</c>, and reads the global back
/// via reflection. This avoids stdout capture while still running the
/// emitted IL end-to-end.
/// </summary>
public class UserStructMethodEmitTests
{
    [Fact]
    public void Plain_Struct_Method_Emits_Without_Virtual()
    {
        var source = """
            package P

            type Point struct {
                X int32
            }

            func (p Point) Foo() int32 {
                return p.X
            }
            """;

        var assembly = CompileToAssembly(source, target: "library");
        var point = assembly.GetTypes().Single(t => t.Name == "Point");
        var foo = point.GetMethod("Foo", BindingFlags.Public | BindingFlags.Instance);

        Assert.NotNull(foo);
        Assert.False(foo!.IsVirtual);
        Assert.False(foo.IsFinal);
        Assert.False((foo.Attributes & MethodAttributes.NewSlot) != 0);
    }

    [Fact]
    public void Class_Method_Still_Emits_Virtual_NewSlot_Final()
    {
        var source = """
            package P

            type Greeter class {
                func Greet() int32 {
                    return 42
                }
            }
            """;

        var assembly = CompileToAssembly(source, target: "library");
        var greeter = assembly.GetTypes().Single(t => t.Name == "Greeter");
        var greet = greeter.GetMethod("Greet", BindingFlags.Public | BindingFlags.Instance);

        Assert.NotNull(greet);
        Assert.True(greet!.IsVirtual);
        Assert.True(greet.IsFinal);
        Assert.True((greet.Attributes & MethodAttributes.NewSlot) != 0);
    }

    [Fact]
    public void Method_On_Global_Variable_Receiver_Round_Trips()
    {
        // The receiver `p` is a top-level `let`, which is emitted as a
        // public static field on `<Program>`. The call site must use
        // `ldsflda p` (not `ldsfld p`) so the instance method receives a
        // managed pointer as `this`.
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
            }

            func (p Point) Distance() int32 {
                return p.X * p.X + p.Y * p.Y
            }

            let p = Point{X: 3, Y: 4}
            public var result = p.Distance()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        Assert.NotNull(entry);
        Assert.NotNull(resultField);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(25, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Method_On_Local_Variable_Receiver_Round_Trips()
    {
        // A local-variable receiver inside a function body must use
        // `ldloca` to push the address as `this`.
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
            }

            func (p Point) Sum() int32 {
                return p.X + p.Y
            }

            public var result = 0
            func run() {
                var p = Point{X: 10, Y: 32}
                result = p.Sum()
            }

            run()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(42, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void RefStruct_Method_On_Rvalue_Receiver_Round_Trips()
    {
        var source = """
            package P
            import System

            type Wrap ref struct {
                V int32
            }

            func (w Wrap) Show() int32 {
                return w.V
            }

            func make() Wrap {
                return Wrap{V: 99}
            }

            public var result = make().Show()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(99, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Imported_RefStruct_Method_On_Rvalue_Receiver_Round_Trips()
    {
        var source = """
            package P
            import System

            public var result = 0

            func run() {
                var s = System.MemoryExtensions.AsSpan("hello")
                result = s.Slice(0, 3).Length
            }

            run()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(3, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Method_On_Rvalue_Receiver_Preserves_Existing_NonRefStruct_Behavior()
    {
        // The receiver `makePoint(...)` is an rvalue with no addressable
        // storage. The emitter spills it to a local and passes `ldloca` as
        // the instance method's managed `this` pointer.
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
            }

            func (p Point) Sum() int32 {
                return p.X + p.Y
            }

            func makePoint(x int32, y int32) Point {
                return Point{X: x, Y: y}
            }

            public var result = makePoint(5, 6).Sum()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(11, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Method_On_Nested_Field_Receiver_With_Addressable_Outer_Round_Trips()
    {
        // The receiver `o.I` is a field access whose outer (`o`) is itself
        // an addressable global. The emitter must chain `ldsflda o; ldflda
        // I` so the instance method receives a real managed pointer.
        var source = """
            package P
            import System

            type Inner struct {
                V int32
            }

            type Outer struct {
                I Inner
            }

            func (i Inner) Triple() int32 {
                return i.V * 3
            }

            let o = Outer{I: Inner{V: 7}}
            public var result = o.I.Triple()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(21, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Method_On_Nested_Field_Receiver_With_Rvalue_Outer_Round_Trips()
    {
        // The receiver `makeOuter().I` is a field access whose outer is
        // an rvalue (a call result). `ldflda I` against a value on the
        // stack is invalid IL (InvalidProgramException); the emitter must
        // spill the whole field-chain value to a local and pass its address.
        var source = """
            package P
            import System

            type Inner struct {
                V int32
            }

            type Outer struct {
                I Inner
            }

            func (i Inner) Triple() int32 {
                return i.V * 3
            }

            func makeOuter() Outer {
                return Outer{I: Inner{V: 5}}
            }

            public var result = makeOuter().I.Triple()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(15, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Method_On_Receiver_Within_Another_Method_Round_Trips()
    {
        // Inside a struct instance method, the implicit `this` (arg0) is
        // already a managed pointer. Calling another method on the same
        // value must load arg0 (not arga.0, which would be a pointer to a
        // pointer).
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
            }

            func (p Point) Sum() int32 {
                return p.X + p.Y
            }

            func (p Point) Twice() int32 {
                return p.Sum() + p.Sum()
            }

            let p = Point{X: 3, Y: 4}
            public var result = p.Twice()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(14, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Method_On_Array_Index_Receiver_Round_Trips()
    {
        // An array element is an rvalue when read with `arr[i]`. The
        // emitter routes this through a local spill; the call's return value
        // is observed but mutations on `this` would not propagate to
        // `arr[i]` (consistent with the CLR semantics for rvalue
        // receivers).
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
            }

            func (p Point) Sum() int32 {
                return p.X + p.Y
            }

            let arr = []Point{Point{X: 1, Y: 2}, Point{X: 3, Y: 4}}
            public var result = arr[1].Sum()
            """;

        var assembly = CompileToAssembly(source, target: "exe");
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        Assert.Equal(7, (int)resultField!.GetValue(null)!);
    }

    private static Assembly CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_user_method_emit_").FullName;
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
        IlVerifier.Verify(outPath, ignoredErrorCodes: IlVerifier.KnownIssues.RefStruct);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}

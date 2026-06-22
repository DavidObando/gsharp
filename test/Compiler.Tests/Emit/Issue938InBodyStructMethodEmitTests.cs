// <copyright file="Issue938InBodyStructMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #938 regression tests. There was previously no warning-free way to
/// declare an instance method on an owned <c>struct</c> / <c>data struct</c>:
/// the in-body <c>func</c> form was rejected by the parser (<c>GS0005</c>) and
/// the receiver-clause form <c>func (p Point) Sum() int32</c> bound but emitted
/// the <c>GS0314</c> warning (ADR-0079). The fix allows the canonical in-body
/// form for value types — the method binds onto the struct with a synthesized
/// by-ref <c>this</c>, reusing the existing owned-struct method lowering and
/// emission.
///
/// Each test compiles a small program that writes a call's result into a
/// top-level global, invokes <c>&lt;Main&gt;$</c>, and reads the global back via
/// reflection to observe the emitted IL running end-to-end. The compiler's
/// diagnostic output is captured and asserted to be free of warnings (notably
/// <c>GS0314</c> and the parser's <c>GS0005</c>).
/// </summary>
public class Issue938InBodyStructMethodEmitTests
{
    [Fact]
    public void InBody_Struct_Method_Compiles_Without_Diagnostics_And_Runs()
    {
        // The exact Repro A shape from issue #938, extended to call the method.
        var source = """
            package Repro
            import System

            struct Point {
                var X int32
                var Y int32
                func Sum() int32 { return X + Y }
            }

            func compute() int32 {
                var p = Point{X: 3, Y: 4}
                return p.Sum()
            }

            public var result = compute()
            """;

        var (assembly, diagnostics) = CompileToAssembly(source, target: "exe");
        AssertNoDiagnostics(diagnostics);

        Assert.Equal(7, InvokeAndReadResult(assembly, "result"));
    }

    [Fact]
    public void InBody_Struct_Method_Has_NonVirtual_Shape()
    {
        // Value-type instance methods must not be virtual/newslot/final — the
        // call site uses `call`, not `callvirt`, against a managed `this`.
        var source = """
            package P

            struct Point {
                var X int32
                func Foo() int32 { return X }
            }
            """;

        var (assembly, diagnostics) = CompileToAssembly(source, target: "library");
        AssertNoDiagnostics(diagnostics);

        var point = assembly.GetTypes().Single(t => t.Name == "Point");
        var foo = point.GetMethod("Foo", BindingFlags.Public | BindingFlags.Instance);

        Assert.NotNull(foo);
        Assert.False(foo!.IsVirtual);
        Assert.False(foo.IsFinal);
        Assert.False((foo.Attributes & MethodAttributes.NewSlot) != 0);
    }

    [Fact]
    public void InBody_Struct_Method_Mutating_This_Round_Trips_By_Ref()
    {
        // A struct instance method that writes a field mutates through the
        // by-ref `this`; the mutation must be visible on the receiver storage.
        var source = """
            package P

            struct Counter {
                var N int32
                func Bump() { N = N + 1 }
                func Value() int32 { return N }
            }

            func compute() int32 {
                var c = Counter{N: 10}
                c.Bump()
                c.Bump()
                c.Bump()
                return c.Value()
            }

            public var result = compute()
            """;

        var (assembly, diagnostics) = CompileToAssembly(source, target: "exe");
        AssertNoDiagnostics(diagnostics);

        Assert.Equal(13, InvokeAndReadResult(assembly, "result"));
    }

    [Fact]
    public void InBody_DataStruct_Method_Compiles_Without_Diagnostics_And_Runs()
    {
        var source = """
            package P

            data struct Vec {
                var X int32
                var Y int32
                func Len2() int32 { return X * X + Y * Y }
            }

            public var result = Vec{X: 3, Y: 4}.Len2()
            """;

        var (assembly, diagnostics) = CompileToAssembly(source, target: "exe");
        AssertNoDiagnostics(diagnostics);

        Assert.Equal(25, InvokeAndReadResult(assembly, "result"));
    }

    [Fact]
    public void InBody_Generic_Struct_Method_Compiles_Without_Diagnostics_And_Runs()
    {
        var source = """
            package P

            struct Box[T] {
                var V T
                func Get() T { return V }
            }

            public var result = Box[int32]{V: 9}.Get()
            """;

        var (assembly, diagnostics) = CompileToAssembly(source, target: "exe");
        AssertNoDiagnostics(diagnostics);

        Assert.Equal(9, InvokeAndReadResult(assembly, "result"));
    }

    [Fact]
    public void InBody_Struct_Method_Calling_Sibling_Method_Round_Trips()
    {
        // Inside a struct method the implicit `this` is already a managed
        // pointer; calling a sibling method must load arg0, not its address.
        var source = """
            package P

            struct Point {
                var X int32
                var Y int32
                func Sum() int32 { return X + Y }
                func Twice() int32 { return Sum() + Sum() }
            }

            public var result = Point{X: 3, Y: 4}.Twice()
            """;

        var (assembly, diagnostics) = CompileToAssembly(source, target: "exe");
        AssertNoDiagnostics(diagnostics);

        Assert.Equal(14, InvokeAndReadResult(assembly, "result"));
    }

    private static void AssertNoDiagnostics(string diagnostics)
    {
        Assert.True(
            !diagnostics.Contains("warning", StringComparison.OrdinalIgnoreCase)
                && !diagnostics.Contains("error", StringComparison.OrdinalIgnoreCase),
            $"Expected a clean compile with zero diagnostics, but got:\n{diagnostics}");
    }

    private static int InvokeAndReadResult(Assembly assembly, string globalName)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(globalName, BindingFlags.Public | BindingFlags.Static);

        Assert.NotNull(entry);
        Assert.NotNull(resultField);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });

        return (int)resultField!.GetValue(null)!;
    }

    private static (Assembly Assembly, string Diagnostics) CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue938_emit_").FullName;
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

        var diagnostics = compileOut.ToString() + compileErr.ToString();

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(outPath, ignoredErrorCodes: IlVerifier.KnownIssues.RefStruct);

        var bytes = File.ReadAllBytes(outPath);
        return (Assembly.Load(bytes), diagnostics);
    }
}

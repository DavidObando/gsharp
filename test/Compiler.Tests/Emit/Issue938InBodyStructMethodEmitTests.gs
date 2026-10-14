// <copyright file="Issue938InBodyStructMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #938 regression tests. There was previously no warning-free way to
/// declare an instance method on an owned `struct` / `data struct`:
/// the in-body `func` form was rejected by the parser (`GS0005`) and
/// the receiver-clause form `func (p Point) Sum() int32` bound but emitted
/// the `GS0314` warning (ADR-0079). The fix allows the canonical in-body
/// form for value types — the method binds onto the struct with a synthesized
/// by-ref `this`, reusing the existing owned-struct method lowering and
/// emission.
///
/// Each test compiles a small program that writes a call's result into a
/// top-level global, invokes `<Main>$`, and reads the global back via
/// reflection to observe the emitted IL running end-to-end. The compiler's
/// diagnostic output is captured and asserted to be free of warnings (notably
/// `GS0314` and the parser's `GS0005`).
open class Issue938InBodyStructMethodEmitTests {
    @Fact
    func InBody_Struct_Method_Compiles_Without_Diagnostics_And_Runs() {
        // The exact Repro A shape from issue #938, extended to call the method.
        let source = `package Repro
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

public var result = compute()`
        let (assembly, diagnostics) = CompileToAssembly(source, target: "exe")
        AssertNoDiagnostics(diagnostics)
        Assert.Equal(7, InvokeAndReadResult(assembly, "result"))
    }

    @Fact
    func InBody_Struct_Method_Has_NonVirtual_Shape() {
        // Value-type instance methods must not be virtual/newslot/final — the
        // call site uses `call`, not `callvirt`, against a managed `this`.
        let source = `package P

struct Point {
    var X int32
    func Foo() int32 { return X }
}`
        let (assembly, diagnostics) = CompileToAssembly(source, target: "library")
        AssertNoDiagnostics(diagnostics)
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let foo MethodInfo? = point.GetMethod("Foo", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(foo)
        Assert.False(foo!!.IsVirtual)
        Assert.False(foo!!.IsFinal)
        Assert.False((foo!!.Attributes & MethodAttributes.NewSlot) != 0)
    }

    @Fact
    func InBody_Struct_Method_Mutating_This_Round_Trips_By_Ref() {
        // A struct instance method that writes a field mutates through the
        // by-ref `this`; the mutation must be visible on the receiver storage.
        let source = `package P

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

public var result = compute()`
        let (assembly, diagnostics) = CompileToAssembly(source, target: "exe")
        AssertNoDiagnostics(diagnostics)
        Assert.Equal(13, InvokeAndReadResult(assembly, "result"))
    }

    @Fact
    func InBody_DataStruct_Method_Compiles_Without_Diagnostics_And_Runs() {
        let source = `package P

data struct Vec {
    var X int32
    var Y int32
    func Len2() int32 { return X * X + Y * Y }
}

public var result = Vec{X: 3, Y: 4}.Len2()`
        let (assembly, diagnostics) = CompileToAssembly(source, target: "exe")
        AssertNoDiagnostics(diagnostics)
        Assert.Equal(25, InvokeAndReadResult(assembly, "result"))
    }

    @Fact
    func InBody_Generic_Struct_Method_Compiles_Without_Diagnostics_And_Runs() {
        let source = `package P

struct Box[T] {
    var V T
    func Get() T { return V }
}

public var result = Box[int32]{V: 9}.Get()`
        let (assembly, diagnostics) = CompileToAssembly(source, target: "exe")
        AssertNoDiagnostics(diagnostics)
        Assert.Equal(9, InvokeAndReadResult(assembly, "result"))
    }

    @Fact
    func InBody_Struct_Method_Calling_Sibling_Method_Round_Trips() {
        // Inside a struct method the implicit `this` is already a managed
        // pointer; calling a sibling method must load arg0, not its address.
        let source = `package P

struct Point {
    var X int32
    var Y int32
    func Sum() int32 { return X + Y }
    func Twice() int32 { return Sum() + Sum() }
}

public var result = Point{X: 3, Y: 4}.Twice()`
        let (assembly, diagnostics) = CompileToAssembly(source, target: "exe")
        AssertNoDiagnostics(diagnostics)
        Assert.Equal(14, InvokeAndReadResult(assembly, "result"))
    }

    shared {
        private func AssertNoDiagnostics(diagnostics string) {
            Assert.True(
                !diagnostics.Contains("warning", StringComparison.OrdinalIgnoreCase) && !diagnostics.Contains(
                    "error",
                    StringComparison.OrdinalIgnoreCase
                ),
                (`Expected a clean compile with zero diagnostics, but got:
` + "$diagnostics")
            )
        }

        private func InvokeAndReadResult(assembly Assembly, globalName string) int32 {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField(globalName, BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(entry)
            Assert.NotNull(resultField)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return int32(resultField!!.GetValue(nil)!!)
        }

        private func CompileToAssembly(source string, target string)(Assembly Assembly, Diagnostics string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue938_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            let diagnostics = compileOut.ToString() + compileErr.ToString()
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            let bytes = File.ReadAllBytes(outPath)
            return (EmittedFixture.Load(bytes), diagnostics)
        }
    }
}

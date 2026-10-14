// <copyright file="UserStructPropertyEmitTests.cs" company="GSharp">
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

/// Issue #418 (P1-5) regression tests. Reading or writing a G# property on
/// a value-type (struct) receiver must pass a managed pointer as `this`
/// for every receiver shape — including method-call results, indexer reads,
/// tuple elements, and nested-field chains — not just a plain
/// `BoundVariableExpression`. Pushing the struct value as `this`
/// reinterprets the bits as the pointer and crashes the JIT (SIGSEGV /
/// (cref:InvalidProgramException)).
///
/// Each test compiles a small program, invokes `<Main>$`, and
/// reads a top-level `result` field via reflection.
open class UserStructPropertyEmitTests {
    @Fact
    func PropertyAccess_On_Variable_Struct_Receiver_RoundTrips() {
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
    prop Sum int32 {
        get { return this.X + this.Y }
    }
}

let p = Point{X: 5, Y: 6}
public var result = p.Sum`
        Assert.Equal(11, RunAndGetIntResult(source))
    }

    @Fact
    func PropertyAccess_On_Method_Call_Struct_Receiver_RoundTrips() {
        // Receiver is `makePoint(5, 6)` — a struct rvalue with no
        // addressable storage. Before #418 the getter call received the
        // struct value as `this` and the JIT crashed with SIGSEGV.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
    prop Sum int32 {
        get { return this.X + this.Y }
    }
}

func makePoint(x int32, y int32) Point {
    return Point{X: x, Y: y}
}

public var result = makePoint(5, 6).Sum`
        Assert.Equal(11, RunAndGetIntResult(source))
    }

    @Fact
    func PropertyAccess_On_Nested_Field_Of_Rvalue_RoundTrips() {
        // Receiver is `makeOuter().Inner` — a field-chain whose head is an
        // rvalue. Same spill path as method-call receivers.
        let source = `package P
import System

struct Inner {
    var V int32
    prop Triple int32 {
        get { return this.V * 3 }
    }
}

struct Outer {
    var Inner Inner
}

func makeOuter(v int32) Outer {
    return Outer{Inner: Inner{V: v}}
}

public var result = makeOuter(7).Inner.Triple`
        Assert.Equal(21, RunAndGetIntResult(source))
    }

    @Fact
    func PropertyAccess_On_Indexer_Result_Struct_Receiver_RoundTrips() {
        // Receiver is `arr[0]` — an indexer read returning a struct rvalue.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
    prop Sum int32 {
        get { return this.X + this.Y }
    }
}

let arr = [3]Point{ Point{X: 5, Y: 6}, Point{X: 1, Y: 2}, Point{X: 10, Y: 20} }
public var result = arr[0].Sum`
        Assert.Equal(11, RunAndGetIntResult(source))
    }

    @Fact
    func PropertyAccess_On_Cast_Struct_Receiver_RoundTrips() {
        // Receiver is a cast expression `Point(other)` — synthesised rvalue.
        // The existing code path's `BoundVariableExpression` check skipped
        // this shape and emitted `call get_Sum` against a value on the stack.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
    prop Sum int32 {
        get { return this.X + this.Y }
    }
}

struct Pair {
    var A int32
    var B int32
}

func makePoint(x int32, y int32) Point {
    return Point{X: x, Y: y}
}

// Read property off the result of a sequence of method calls.
public var result = makePoint(makePoint(2, 3).Sum, makePoint(1, 5).Sum).Sum`
        // (2+3) + (1+5) = 11
        Assert.Equal(11, RunAndGetIntResult(source))
    }

    @Fact
    func PropertyAccess_On_Class_Receiver_Still_Uses_Callvirt() {
        // Class receivers must still use callvirt; verify class properties
        // continue to round-trip unchanged.
        let source = `package P
import System

class Box {
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

public var result = makeBox(13).Doubled`
        Assert.Equal(26, RunAndGetIntResult(source))
    }

    @Fact
    func PropertyAssignment_On_Variable_Struct_Receiver_RoundTrips() {
        let source = `package P
import System

struct Holder {
    prop raw int32
    prop V int32 {
        get { return this.raw }
        set(v) { this.raw = v * 2 }
    }
}

var h = Holder{}
public var result = h.V = 21`
        // Issue #418 (P1-2): assignment expression yields the spilled assigned
        // value (21), not a getter re-read — matches Roslyn semantics and
        // avoids double-evaluating the receiver / re-invoking the getter.
        Assert.Equal(21, RunAndGetIntResult(source))
    }

    shared {
        private func RunAndGetIntResult(source string) int32 {
            let assembly = CompileToAssembly(source, target: "exe")
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
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

        private func CompileToAssembly(source string, target string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_user_prop_emit_").FullName
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
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }
    }
}

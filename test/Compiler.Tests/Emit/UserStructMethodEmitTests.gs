// <copyright file="UserStructMethodEmitTests.cs" company="GSharp">
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

/// Issue #409 regression tests. An in-body method
/// `struct Point { func Distance() int32 { ... } }` on a user-defined
/// struct binds as an instance method on a value type (Phase 6.4). ADR-0182
/// retired the receiver-clause spelling of an owned instance method (a
/// receiver clause is unconditionally an extension now), so the in-body form
/// is the only way to exercise this path. The emitter must pass a managed
/// pointer as `this` for every receiver shape the call site can take;
/// pushing the struct value directly reinterprets the bits as the
/// `this` pointer and corrupts the stack (SIGSEGV, or
/// (cref:InvalidProgramException) at JIT time).
///
/// Each test compiles a small program that writes the call's result into a
/// top-level global, invokes `<Main>$`, and reads the global back
/// via reflection. This avoids stdout capture while still running the
/// emitted IL end-to-end.
open class UserStructMethodEmitTests {
    @Fact
    func Plain_Struct_Method_Emits_Without_Virtual() {
        let source = `package P

struct Point {
    var X int32

    func Foo() int32 {
        return X
    }
}`
        let assembly = CompileToAssembly(source, target: "library")
        let point = assembly.GetTypes().Single((t Type) -> t.Name == "Point")
        let foo MethodInfo? = point.GetMethod("Foo", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(foo)
        Assert.False(foo!!.IsVirtual)
        Assert.False(foo!!.IsFinal)
        Assert.False((foo!!.Attributes & MethodAttributes.NewSlot) != 0)
    }

    @Fact
    func Class_Method_Emits_Without_Virtual() {
        let source = `package P

class Greeter {
    func Greet() int32 {
        return 42
    }
}`
        let assembly = CompileToAssembly(source, target: "library")
        let greeter = assembly.GetTypes().Single((t Type) -> t.Name == "Greeter")
        let greet MethodInfo? = greeter.GetMethod("Greet", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(greet)
        Assert.False(greet!!.IsVirtual)
        Assert.False(greet!!.IsFinal)
        Assert.False((greet!!.Attributes & MethodAttributes.NewSlot) != 0)
    }

    @Fact
    func Method_On_Global_Variable_Receiver_Round_Trips() {
        // The receiver `p` is a top-level `let`, which is emitted as a
        // public static field on `<Program>`. The call site must use
        // `ldsflda p` (not `ldsfld p`) so the instance method receives a
        // managed pointer as `this`.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32

    func Distance() int32 {
        return X * X + Y * Y
    }
}

let p = Point{X: 3, Y: 4}
public var result = p.Distance()`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
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
        Assert.Equal(25, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Method_On_Local_Variable_Receiver_Round_Trips() {
        // A local-variable receiver inside a function body must use
        // `ldloca` to push the address as `this`.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32

    func Sum() int32 {
        return X + Y
    }
}

public var result = 0
func run() {
    var p = Point{X: 10, Y: 32}
    result = p.Sum()
}

run()`
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
        Assert.Equal(42, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func RefStruct_Method_On_Rvalue_Receiver_Round_Trips() {
        let source = `package P
import System

ref struct Wrap {
    var V int32

    func Show() int32 {
        return V
    }
}

func make() Wrap {
    return Wrap{V: 99}
}

public var result = make().Show()`
        let assembly = CompileToAssembly(source, target: "exe", ignoredErrorScope: "<Program>\\.make$$")
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
        Assert.Equal(99, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Imported_RefStruct_Method_On_Rvalue_Receiver_Round_Trips() {
        let source = `package P
import System

public var result = 0

func run() {
    var s = System.MemoryExtensions.AsSpan("hello")
    result = s.Slice(0, 3).Length
}

run()`
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
        Assert.Equal(3, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Method_On_Rvalue_Receiver_Preserves_Existing_NonRefStruct_Behavior() {
        // The receiver `makePoint(...)` is an rvalue with no addressable
        // storage. The emitter spills it to a local and passes `ldloca` as
        // the instance method's managed `this` pointer.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32

    func Sum() int32 {
        return X + Y
    }
}

func makePoint(x int32, y int32) Point {
    return Point{X: x, Y: y}
}

public var result = makePoint(5, 6).Sum()`
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
        Assert.Equal(11, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Method_On_Nested_Field_Receiver_With_Addressable_Outer_Round_Trips() {
        // The receiver `o.I` is a field access whose outer (`o`) is itself
        // an addressable global. The emitter must chain `ldsflda o; ldflda
        // I` so the instance method receives a real managed pointer.
        let source = `package P
import System

struct Inner {
    var V int32

    func Triple() int32 {
        return V * 3
    }
}

struct Outer {
    var I Inner
}

let o = Outer{I: Inner{V: 7}}
public var result = o.I.Triple()`
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
        Assert.Equal(21, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Method_On_Nested_Field_Receiver_With_Rvalue_Outer_Round_Trips() {
        // The receiver `makeOuter().I` is a field access whose outer is
        // an rvalue (a call result). `ldflda I` against a value on the
        // stack is invalid IL (InvalidProgramException); the emitter must
        // spill the whole field-chain value to a local and pass its address.
        let source = `package P
import System

struct Inner {
    var V int32

    func Triple() int32 {
        return V * 3
    }
}

struct Outer {
    var I Inner
}

func makeOuter() Outer {
    return Outer{I: Inner{V: 5}}
}

public var result = makeOuter().I.Triple()`
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
        Assert.Equal(15, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Method_On_Receiver_Within_Another_Method_Round_Trips() {
        // Inside a struct instance method, the implicit `this` (arg0) is
        // already a managed pointer. Calling another method on the same
        // value must load arg0 (not arga.0, which would be a pointer to a
        // pointer).
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32

    func Sum() int32 {
        return X + Y
    }

    func Twice() int32 {
        return Sum() + Sum()
    }
}

let p = Point{X: 3, Y: 4}
public var result = p.Twice()`
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
        Assert.Equal(14, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Method_On_Array_Index_Receiver_Round_Trips() {
        // An array element is an rvalue when read with `arr[i]`. The
        // emitter routes this through a local spill; the call's return value
        // is observed but mutations on `this` would not propagate to
        // `arr[i]` (consistent with the CLR semantics for rvalue
        // receivers).
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32

    func Sum() int32 {
        return X + Y
    }
}

let arr = []Point{Point{X: 1, Y: 2}, Point{X: 3, Y: 4}}
public var result = arr[1].Sum()`
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
        Assert.Equal(7, int32(resultField!!.GetValue(nil)!!))
    }

    shared {
        private func CompileToAssembly(source string, target string, ignoredErrorScope string? = nil) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_user_method_emit_").FullName
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
            IlVerifier.Verify(
                outPath,
                ignoredErrorCodes: if ignoredErrorScope == nil {
                    default([]?string)
                } else {
                    IlVerifier.KnownIssues.RefStruct
                },
                ignoredErrorScope: ignoredErrorScope
            )
            return EmittedFixture.Load(outPath)
        }
    }
}

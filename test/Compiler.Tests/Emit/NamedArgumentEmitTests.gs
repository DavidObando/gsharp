// <copyright file="NamedArgumentEmitTests.cs" company="GSharp">
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

/// Issue #343 emit tests. Compiles GSharp programs that use named arguments
/// at call sites and verifies the resulting PE executes with the same
/// observable behavior as the equivalent positional form. Binding maps values
/// to parameter slots while preserving lexical source evaluation through
/// ordered temporary captures.
open class NamedArgumentEmitTests {
    @Fact
    func UserFunction_NamedArguments_ReorderToParameterOrder_AtEntryPoint() {
        // sub(10, 3) - sub(y: 3, x: 10) - sub(10, y: 3) all yield 7.
        let source = `package P
import System

public var result = 0

func sub(x int32, y int32) int32 {
    return x - y
}

let a = sub(10, 3)
let b = sub(y: 3, x: 10)
let c = sub(10, y: 3)
result = a * 100 + b * 10 + c`
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
        Assert.Equal(777, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func UserFunction_ReorderedNamedArguments_EvaluateInSourceOrder() {
        let source = `package P

public var trace = ""

func mark(label string, value int32) int32 {
    trace = trace + label
    return value
}

func consume(a int32, b int32) {
    trace = trace + "$a$b"
}

consume(b: mark("B", 2), a: mark("A", 1))`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let traceField FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("BA12", cast[string](traceField!!.GetValue(nil)!!))
    }

    @Fact
    func ClrInstance_ReorderedNamedArguments_EvaluateInSourceOrder() {
        let source = `package P

public var trace = ""
public var result = -1

func markInt(label string, value int32) int32 {
    trace = trace + label
    return value
}

func markString(label string, value string) string {
    trace = trace + label
    return value
}

result = "hello".IndexOf(
    startIndex: markInt("S", 0),
    value: markString("V", "h"))`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let traceField FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("SV", cast[string](traceField!!.GetValue(nil)!!))
        Assert.Equal(0, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func ClrStatic_ReorderedNamedArguments_DoNotCaptureNilIntoALocal() {
        // Issue #3880: reordered calls captured every source argument into a
        // temp, including side-effect-free nil, whose unencodable local type
        // crashed emission with GS9998.
        let source = `package P

public var trace = ""
public var result = 0

func mark(value string) string {
    trace = trace + "B"
    return value
}

result = string.Compare(
    strB: mark("x"),
    strA: nil)`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let traceField FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("B", cast[string](traceField!!.GetValue(nil)!!))
        Assert.Equal(-1, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func UserFunction_ReorderedNamedArguments_CaptureSideEffectingNilExpression() {
        let source = `package P

public var trace = ""

func mark(label string) bool {
    trace = trace + label
    return true
}

func consume(a string?, b string?) {
    trace = trace + if a == nil && b == nil { "N" } else { "V" }
}

consume(
    b: if mark("B") { nil } else { nil },
    a: if mark("A") { nil } else { nil })`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let traceField FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("BAN", cast[string](traceField!!.GetValue(nil)!!))
    }

    @Fact
    func UserClassPrimaryCtor_NamedArguments_ReorderFields() {
        let source = `package P
import System

class Point(X int32, Y int32) {
}

public var result = 0

let p = Point(Y: 7, X: 3)
result = p.X * 10 + p.Y`
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
        Assert.Equal(37, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func UserClassPrimaryCtor_NamedArguments_EvaluateInSourceOrder() {
        let source = `package P

class Point(X int32, Y int32) {
}

public var trace = ""
public var result = 0

func mark(label string, value int32) int32 {
    trace = trace + label
    return value
}

let p = Point(Y: mark("Y", 7), X: mark("X", 3))
result = p.X * 10 + p.Y`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let traceField FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("YX", cast[string](traceField!!.GetValue(nil)!!))
        Assert.Equal(37, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func ClrInstance_StringIndexOf_NamedArguments_ReorderedCorrectly() {
        let source = `package P
import System

public var result = 0

let s = "hello world"
result = s.IndexOf(value: "world", startIndex: 0)`
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
        Assert.Equal(6, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func UserExtension_NamedArguments_EvaluateInSourceOrder() {
        let source = `package P

class Box {
}

public var trace = ""

func mark(label string, value int32) int32 {
    trace = trace + label
    return value
}

func (box Box) Consume(a int32, b int32) {
    trace = trace + "$a$b"
}

let box = Box()
box.Consume(b: mark("B", 2), a: mark("A", 1))`
        let assembly = CompileToAssembly(source, target: "exe")
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let entry MethodInfo? = program.GetMethod(
            "<Main>$$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        let traceField FieldInfo? = program.GetField("trace", BindingFlags.Public | BindingFlags.Static)
        entry!!.Invoke(
            nil,
            if entry!!.GetParameters().Length == 0 {
                default([]?object)
            } else {
                []object{Array.Empty[string]()}
            }
        )
        Assert.Equal("BA12", cast[string](traceField!!.GetValue(nil)!!))
    }

    @Fact
    func UserStaticMethod_NamedArguments_BindAndEvaluate() {
        let source = `package P

class Fixture {
    shared {
        func Describe(name string, count int32, loud bool) string {
            return "$name:$count:$loud"
        }
    }
}

public var result = Fixture.Describe(
    name: "cat",
    count: 2,
    loud: false)`
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
        Assert.Equal("cat:2:False", cast[string](resultField!!.GetValue(nil)!!))
    }

    @Fact
    func UserStaticVariadic_InPositionNamedThenPositional_BindsAndEvaluates() {
        let source = `package P

class Encryptor {
    shared {
        func Merge(additionalCapacity int32, values ...int32) int32 {
            return additionalCapacity + values.Length
        }
    }
}

public var result = Encryptor.Merge(
    additionalCapacity: 5,
    10,
    20,
    30)`
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
        Assert.Equal(8, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func DelegateAndFunctionValues_NamedArguments_BindAndEvaluate() {
        let source = `package P

delegate Operation(x int32, y int32) int32;

func subtract(x int32, y int32) int32 {
    return x - y
}

public var result = 0

let named Operation = subtract
let structural (int32, int32) -> int32 =
    func(x int32, y int32) int32 {
        return x - y
    }

result = named(y: 3, x: 10) * 10 +
    structural(y: 3, x: 10)`
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
        Assert.Equal(77, int32(resultField!!.GetValue(nil)!!))
    }

    shared {
        private func CompileToAssembly(source string, target string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_named_arg_emit_").FullName
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

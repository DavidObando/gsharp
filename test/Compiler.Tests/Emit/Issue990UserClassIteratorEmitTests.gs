// <copyright file="Issue990UserClassIteratorEmitTests.cs" company="GSharp">
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

/// Issue #990 — emit + IL-verify + run coverage for generators whose
/// element type is a user-declared reference type (e.g.
/// `sequence[Shape]` where `Shape` is a user class).
///
/// The crash was a GS9998 ICE: "Conversion from 'Shape' to 'object'
/// is not yet supported by the emitter". The synthesized non-generic
/// `IEnumerator.Current` property converts the strongly-typed
/// `<>2__current` field to `object`; a user class has no
/// ClrType during emit, so `IsReferenceCompatible` failed to
/// recognise the reference widening as a no-op.
open class Issue990UserClassIteratorEmitTests {
    @Fact
    func UserReferenceTypeGenerator_Compiles_And_IlVerifies() {
        let source = `package T
open class Shape { }
func shapes() sequence[Shape] { yield Shape() }`
        // CompileToFile asserts gsc exit 0 and runs ilverify.
        CompileToFile(source, target: "library")
    }

    @Fact
    func UserReferenceTypeGenerator_EndToEnd_PrintsShapeTwice() {
        let source = `package T
import System
open class Shape { func Tag() string { return "shape" } }
func shapes() sequence[Shape] {
    yield Shape()
    yield Shape()
}
for s in shapes() { Console.WriteLine(s.Tag()) }`
        let output = CompileRunAndCaptureOutput(source)
        let lines = output
            .ReplaceLineEndings(Environment.NewLine)
            .TrimEnd(Environment.NewLine.ToCharArray())
            .Split(Environment.NewLine)
        Assert.Equal([]string{"shape", "shape"}, lines)
    }

    @Fact
    func UserReferenceTypeGenerator_AccumulatesMultipleInstances() {
        let source = `package T
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
for b in boxes() { total = total + b.value }`
        let assembly = CompileAndRun(source)
        Assert.Equal(60, GetIntField(assembly, "total"))
    }

    @Fact
    func UserValueStructGenerator_AccumulatesCorrectly() {
        let source = `package T
data struct Point { var x int32 }
func points() sequence[Point] {
    yield Point{x: 1}
    yield Point{x: 2}
    yield Point{x: 3}
}
public var total = 0
for p in points() { total = total + p.x }`
        let assembly = CompileAndRun(source)
        Assert.Equal(6, GetIntField(assembly, "total"))
    }

    @Fact
    func BclStringElementControl_StillCompilesAndRuns() {
        let source = `package T
func names() sequence[string] { yield "a" }
public var count = 0
for n in names() { count = count + 1 }`
        let assembly = CompileAndRun(source)
        Assert.Equal(1, GetIntField(assembly, "count"))
    }

    @Fact
    func BclInt32ElementControl_StillCompilesAndRuns() {
        let source = `package T
func nums() sequence[int32] { yield 1 }
public var sum = 0
for n in nums() { sum = sum + n }`
        let assembly = CompileAndRun(source)
        Assert.Equal(1, GetIntField(assembly, "sum"))
    }

    @Fact
    func ReferenceOutVarInWhileCondition_RemainsAssignedAcrossYield() {
        let source = `package T
open class Box { let value int32 init(value int32) { this.value = value } }
open class Cursor {
    private var next int32 = 1
    func TryNext(out index int32, out value Box?) bool {
        if next > 2 {
            index = -1
            value = nil
            return false
        }
        index = next
        value = Box(next)
        next++
        return true
    }
}
public var observed = 0
func boxes() sequence[Box] {
    let cursor = Cursor()
    while cursor.TryNext(out var index, out var value) {
        yield value!!
        observed += value!!.value
    }
}
public var total = 0
for box in boxes() { total += box.value }`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "total"))
        Assert.Equal(3, GetIntField(assembly, "observed"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let outPath = CompileToFile(source, target: "exe")
            let assembly = EmittedFixture.Load(outPath)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return assembly
        }

        private func CompileRunAndCaptureOutput(source string) string {
            let outPath = CompileToFile(source, target: "exe")
            let assembly = EmittedFixture.Load(outPath)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            using let captured = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(prevOut)
            }
            return captured.ToString()
        }

        private func CompileToFile(source string, target string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_990_").FullName
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
            return outPath
        }

        private func GetIntField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let field FieldInfo? = program.GetField(name, BindingFlags.Public | BindingFlags.Static)
            return int32(field!!.GetValue(nil)!!)
        }
    }
}

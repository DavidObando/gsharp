// <copyright file="Issue1002UserClassAsyncIteratorEmitTests.cs" company="GSharp">
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

/// Issue #1002 (parallel to #990) — emit + IL-verify + run coverage for
/// <em>async</em> iterators whose element type is a user-declared
/// reference type (e.g. `IAsyncEnumerable[Shape]` where
/// `Shape` is a user class).
///
/// Before the fix the state machine's
/// `IAsyncEnumerable<T>` / `IAsyncEnumerator<T>`
/// interface rows and the `GetAsyncEnumerator` return signature
/// erased the user element type to `object` via
/// `elementType.ClrType ?? typeof(object)`, producing
/// generic-invariance-invalid IL: an `async func shapes() IAsyncEnumerable[Shape]`
/// kickoff returned a value whose runtime type only implemented
/// `IAsyncEnumerable<object>` (ilverify
/// `StackUnexpected: found ref '...d__1' expected ref 'IAsyncEnumerable`1<T.Shape>'`).
///
/// The consumer side (`await for s in shapes()`) suffered a
/// parallel erasure: the await-for lowering read `Current` off the
/// closed `IAsyncEnumerator<object>` shape, which yielded an
/// `object` assigned into the strongly-typed `Shape` loop slot
/// — also rejected by ilverify even though the reference was correct at
/// runtime.
open class Issue1002UserClassAsyncIteratorEmitTests {
    @Fact
    func UserReferenceTypeAsyncIterator_Compiles_And_IlVerifies() {
        let source = `package T
import System.Collections.Generic
import System.Threading.Tasks
open class Shape { }
async func shapes() IAsyncEnumerable[Shape] {
    yield Shape()
    await Task.Delay(1)
    yield Shape()
}`
        // CompileToFile asserts gsc exit 0 and runs ilverify.
        CompileToFile(source, target: "library")
    }

    @Fact
    func NestedSameCompilationElementAsyncIterator_Compiles_And_IlVerifies() {
        let source = `package T
import System.Collections.Generic
import System.Threading.Tasks
open class Shape { }
async func pairs() IAsyncEnumerable[KeyValuePair[string, Shape]] {
    yield KeyValuePair[string, Shape]("key", Shape())
    await Task.Delay(1)
}`
        let outPath = CompileToFile(source, target: "library")
        let assembly = EmittedFixture.Load(outPath)
        let shapeType = assembly.GetType("T.Shape", throwOnError: true)!!
        let elementType = typeof(System.Collections.Generic.KeyValuePair[_, _]).MakeGenericType(
            typeof(string),
            shapeType
        )
        let asyncEnumerableType = typeof(System.Collections.Generic.IAsyncEnumerable[_]).MakeGenericType(elementType)
        let asyncEnumeratorType = typeof(System.Collections.Generic.IAsyncEnumerator[_]).MakeGenericType(elementType)
        let programType = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let stateMachineType = assembly.GetTypes().Single(
            (type Type) -> type.IsNested && type.Name.StartsWith("<pairs>d__", StringComparison.Ordinal)
        )
        Assert.Equal(
            asyncEnumerableType,
            programType.GetMethod(
                "pairs",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!.ReturnType
        )
        Assert.Contains(asyncEnumerableType, stateMachineType.GetInterfaces())
        Assert.Contains(asyncEnumeratorType, stateMachineType.GetInterfaces())
        Assert.Equal(
            asyncEnumeratorType,
            stateMachineType.GetMethod(
                "GetAsyncEnumerator",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            )!!.ReturnType
        )
        Assert.Equal(
            elementType,
            stateMachineType.GetMethod(
                "get_Current",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            )!!.ReturnType
        )
    }

    @Fact
    func UserReferenceTypeAsyncIterator_EndToEnd_PrintsShapeTwice() {
        let source = `package T
import System
import System.Collections.Generic
import System.Threading.Tasks
open class Shape { func Tag() string { return "shape" } }
async func shapes() IAsyncEnumerable[Shape] {
    yield Shape()
    await Task.Delay(1)
    yield Shape()
}
async func Run() {
    let seq = shapes()
    await for s in seq {
        Console.WriteLine(s.Tag())
    }
}
Run().Wait()`
        let output = CompileRunAndCaptureOutput(source)
        let lines = output
            .ReplaceLineEndings(Environment.NewLine)
            .TrimEnd(Environment.NewLine.ToCharArray())
            .Split(Environment.NewLine)
        Assert.Equal([]string{"shape", "shape"}, lines)
    }

    @Fact
    func UserReferenceTypeAsyncIterator_AccumulatesValues() {
        let source = `package T
import System.Collections.Generic
import System.Threading.Tasks
open class Box { var value int32 = 0 }
async func boxes() IAsyncEnumerable[Box] {
    var a = Box()
    a.value = 10
    yield a
    await Task.Delay(1)
    var b = Box()
    b.value = 20
    yield b
    await Task.Delay(1)
    var c = Box()
    c.value = 30
    yield c
}
public var total = 0
async func Run() {
    await for b in boxes() {
        total = total + b.value
    }
}
Run().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(60, GetIntField(assembly, "total"))
    }

    @Fact
    func UserValueStructAsyncIterator_AccumulatesCorrectly() {
        let source = `package T
import System.Collections.Generic
import System.Threading.Tasks
data struct Point { var x int32 }
async func points() IAsyncEnumerable[Point] {
    yield Point{x: 1}
    await Task.Delay(1)
    yield Point{x: 2}
    await Task.Delay(1)
    yield Point{x: 3}
}
public var total = 0
async func Run() {
    await for p in points() {
        total = total + p.x
    }
}
Run().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(6, GetIntField(assembly, "total"))
    }

    @Fact
    func BclInt32AsyncElementControl_StillCompilesAndRuns() {
        let source = `package T
import System.Collections.Generic
import System.Threading.Tasks
async func nums() IAsyncEnumerable[int32] {
    yield 1
    await Task.Delay(1)
    yield 2
}
public var sum = 0
async func Run() {
    await for n in nums() {
        sum = sum + n
    }
}
Run().Wait()`
        let assembly = CompileAndRun(source)
        Assert.Equal(3, GetIntField(assembly, "sum"))
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
            let tempDir = Directory.CreateTempSubdirectory("gs_1002_").FullName
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

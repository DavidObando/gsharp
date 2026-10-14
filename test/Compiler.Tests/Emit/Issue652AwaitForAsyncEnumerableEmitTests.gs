// <copyright file="Issue652AwaitForAsyncEnumerableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #652: `await for x in y` over `IAsyncEnumerable<T>`
/// triggered GS9998 ("Type must be a type provided by the MetadataLoadContext")
/// because the lowering mixed runtime `typeof(...)` types with
/// MetadataLoadContext-loaded types when constructing generic instantiations.
/// These tests verify that the desugaring correctly derives all helper types
/// from the same context as the stream type.
open class Issue652AwaitForAsyncEnumerableEmitTests {
    @Fact
    func AwaitFor_FreeFunction_Producer_Compiles_And_Runs() {
        // Free function returning IAsyncEnumerable[int32] consumed via await for.
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Inner() IAsyncEnumerable[int32] {
    yield 1
    await Task.Delay(1)
    yield 2
}

async func Consume() {
    var sum = 0
    let seq = Inner()
    await for n in seq {
        sum = sum + n
    }
    Console.WriteLine(sum)
}

Consume().Wait()`
        let (assembly, stdout) = CompileRunCapture(source)
        Assert.Equal("3", stdout.Trim())
    }

    @Fact
    func AwaitFor_ClassMember_Producer_Compiles_And_Runs() {
        // Class method returning IAsyncEnumerable[int32] consumed via await for.
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

class Producer {
    init() {}

    async func Numbers() IAsyncEnumerable[int32] {
        yield 10
        await Task.Delay(1)
        yield 20
        await Task.Delay(1)
        yield 30
    }
}

async func Run() {
    var sum = 0
    let p = Producer()
    await for n in p.Numbers() {
        sum = sum + n
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        let (assembly, stdout) = CompileRunCapture(source)
        Assert.Equal("60", stdout.Trim())
    }

    @Fact
    func AwaitFor_Nested_Compiles_And_Runs() {
        // Two nested await-for loops over independent async enumerables.
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Outer() IAsyncEnumerable[int32] {
    yield 1
    await Task.Delay(1)
    yield 2
}

async func Inner(x int32) IAsyncEnumerable[int32] {
    yield x * 10
    await Task.Delay(1)
    yield x * 100
}

async func Run() {
    var sum = 0
    await for a in Outer() {
        await for b in Inner(a) {
            sum = sum + b
        }
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        // Outer yields 1, 2
        // Inner(1) yields 10, 100 → 110
        // Inner(2) yields 20, 200 → 220
        // Total = 330
        let (assembly, stdout) = CompileRunCapture(source)
        Assert.Equal("330", stdout.Trim())
    }

    @Fact
    func AwaitFor_StringElement_Compiles_And_Runs() {
        // Ensure the fix works for reference-type element types too.
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Words() IAsyncEnumerable[string] {
    yield "hello"
    await Task.Delay(1)
    yield "world"
}

async func Run() {
    var result = ""
    await for w in Words() {
        result = result + w + " "
    }
    Console.Write(result)
}

Run().Wait()`
        let (assembly, stdout) = CompileRunCapture(source)
        Assert.Equal("hello world ", stdout)
    }

    shared {
        private func CompileRunCapture(source string)(assembly Assembly, stdout string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_652_").FullName
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
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
            let assembly = EmittedFixture.Load(outPath)
            // Run the entry point and capture stdout
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let captured = StringWriter()
            let prevOut2 = Console.Out
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
                Console.SetOut(prevOut2)
            }
            return (assembly, captured.ToString().ReplaceLineEndings(Environment.NewLine))
        }
    }
}

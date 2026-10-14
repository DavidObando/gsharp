// <copyright file="Issue937AwaitForBreakContinueEmitTests.cs" company="GSharp">
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

/// Issue #937: `break`, `continue`, and labeled break/continue were
/// rejected ("The keyword 'break' can only be used inside of loops.") inside an
/// `await for` (async foreach over an `IAsyncEnumerable<T>`) loop
/// body, because the binder did not register a loop scope for the async loop the
/// way the synchronous `for … in` loop does. These tests verify full parity:
/// the keywords now bind, lower, and emit with correct runtime semantics.
open class Issue937AwaitForBreakContinueEmitTests {
    @Fact
    func AwaitFor_Break_Compiles_And_Runs() {
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Nums() IAsyncEnumerable[int32] {
    yield 1
    await Task.Delay(1)
    yield 2
    yield 3
    yield 4
}

async func Run() {
    var sum = 0
    await for n in Nums() {
        if n == 3 {
            break
        }
        sum = sum + n
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        // 1 + 2 added; 3 breaks before 4. Sum = 3.
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("3", stdout.Trim())
    }

    @Fact
    func AwaitFor_Continue_Compiles_And_Runs() {
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Nums() IAsyncEnumerable[int32] {
    yield 1
    await Task.Delay(1)
    yield 2
    yield 3
    yield 4
}

async func Run() {
    var sum = 0
    await for n in Nums() {
        if n == 2 {
            continue
        }
        if n == 4 {
            continue
        }
        sum = sum + n
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        // 2 and 4 skipped via continue; 1 + 3 added. Sum = 4.
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("4", stdout.Trim())
    }

    @Fact
    func AwaitFor_BreakAndContinue_Compiles_And_Runs() {
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Nums() IAsyncEnumerable[int32] {
    yield 1
    await Task.Delay(1)
    yield 2
    yield 3
    yield 4
}

async func Run() {
    var sum = 0
    await for n in Nums() {
        if n == 3 {
            break
        }
        if n == 2 {
            continue
        }
        sum = sum + n
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        // 1 added; 2 continues; 3 breaks. Sum = 1.
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("1", stdout.Trim())
    }

    @Fact
    func AwaitFor_LabeledBreakAndContinue_Compiles_And_Runs() {
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Outer() IAsyncEnumerable[int32] {
    yield 1
    await Task.Delay(1)
    yield 2
    yield 3
}

async func Inner() IAsyncEnumerable[int32] {
    yield 10
    await Task.Delay(1)
    yield 20
    yield 30
}

async func Run() {
    var sum = 0
outer:
    await for a in Outer() {
        await for b in Inner() {
            if b == 20 {
                continue outer
            }
            if a == 3 {
                break outer
            }
            sum = sum + a + b
        }
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        // a=1: b=10 -> sum += 11; b=20 -> continue outer.
        // a=2: b=10 -> sum += 12 (=23); b=20 -> continue outer.
        // a=3: b=10 -> break outer.
        // Sum = 23.
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("23", stdout.Trim())
    }

    @Fact
    func AwaitFor_Break_StopsConsuming() {
        // The producer prints each element before yielding it. Because the
        // async stream is pull-based, `break` must stop calling MoveNextAsync,
        // so the element after the break point is never produced.
        let source = `package Probe
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Stream() IAsyncEnumerable[int32] {
    Console.WriteLine("produce 1")
    yield 1
    await Task.Delay(1)
    Console.WriteLine("produce 2")
    yield 2
    Console.WriteLine("produce 3")
    yield 3
}

async func Run() {
    var sum = 0
    await for n in Stream() {
        sum = sum + n
        if n == 2 {
            break
        }
    }
    Console.WriteLine(sum)
}

Run().Wait()`
        // 1 and 2 produced and summed; break prevents "produce 3". Sum = 3.
        let (_, stdout) = CompileRunCapture(source)
        Assert.Equal("produce 1${Environment.NewLine}produce 2${Environment.NewLine}3", stdout.Trim())
    }

    shared {
        private func CompileRunCapture(source string)(assembly Assembly, stdout string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_937_").FullName
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

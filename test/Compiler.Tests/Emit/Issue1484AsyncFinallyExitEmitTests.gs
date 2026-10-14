// <copyright file="Issue1484AsyncFinallyExitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// End-to-end emit regression tests for issue #1484: generalized async
/// try/finally exit handling (Pattern C). Every non-fall-through exit that
/// leaves a `try` whose `finally` awaits — `return`, `break`,
/// `continue` (the latter two surfaced to the async rewriter as
/// (cref:GSharp.Core.CodeAnalysis.Binding.BoundGotoStatement) after
/// lowering) — must run the awaited finally first and then perform the exit
/// with the correct value/target. Before the fix the awaited finally was
/// skipped on those paths.
///
/// Each test gives every package / function / global a UNIQUE name
/// because the in-process compiler's `FunctionTypeSymbol` cache is not
/// cleared between tests. Every emitted assembly is run through ilverify via
/// (cref:IlVerifier) so the funneled control flow is proven verifiable.
open class Issue1484AsyncFinallyExitEmitTests {
    // (a) Early `return <value>` out of a try-with-async-finally inside a loop
    //     (the exact issue #1484 repro). The finally must run on the iteration
    //     that returns, BEFORE the early return transfers control.
    @Fact
    func EarlyReturn_Through_Awaited_Finally_Runs_Finally_Then_Returns() {
        let source = `package AsyncPatternCReturnPkg

import System
import System.Threading.Tasks

public var flushCountRet = 0
public var resultRet = 0

async func flushRet() int32 {
    await Task.Delay(1)
    return 1
}

async func pickRet(items []int32) int32 {
    for i in 0 ... items.Length {
        try {
            if items[i] > 0 {
                return items[i]
            }
        } finally {
            flushCountRet = flushCountRet + await flushRet()
        }
    }
    return -1
}

resultRet = pickRet([]int32{0, 5, 9}).Result`
        let (program, _) = CompileAndRun(source, "gs1484_return_")
        // i=0: finally runs (flush=1); i=1: items[1]==5>0 → return 5, but the
        // finally runs FIRST (flush=2) → result 5, flushCount 2.
        Assert.Equal(5, ReadInt(program, "resultRet"))
        Assert.Equal(2, ReadInt(program, "flushCountRet"))
    }

    // (b) `break` out of a loop from inside a try-with-async-finally.
    @Fact
    func Break_Through_Awaited_Finally_Runs_Finally_Then_Breaks() {
        let source = `package AsyncPatternCBreakPkg

import System
import System.Threading.Tasks

public var flushCountBrk = 0
public var resultBrk = 0

async func flushBrk() int32 {
    await Task.Delay(1)
    return 1
}

async func pickBrk(items []int32) int32 {
    var found = -1
    for i in 0 ... items.Length {
        try {
            if items[i] > 0 {
                found = items[i]
                break
            }
        } finally {
            flushCountBrk = flushCountBrk + await flushBrk()
        }
    }
    return found
}

resultBrk = pickBrk([]int32{0, 5, 9}).Result`
        let (program, _) = CompileAndRun(source, "gs1484_break_")
        // i=0 finally (flush=1); i=1 sets found=5 then breaks, finally runs
        // first (flush=2). Loop stops → found 5.
        Assert.Equal(5, ReadInt(program, "resultBrk"))
        Assert.Equal(2, ReadInt(program, "flushCountBrk"))
    }

    // (c) `continue` from inside a try-with-async-finally.
    @Fact
    func Continue_Through_Awaited_Finally_Runs_Finally_Then_Continues() {
        let source = `package AsyncPatternCContinuePkg

import System
import System.Threading.Tasks

public var flushCountCont = 0
public var resultCont = 0

async func flushCont() int32 {
    await Task.Delay(1)
    return 1
}

async func sumCont(items []int32) int32 {
    var total = 0
    for i in 0 ... items.Length {
        try {
            if items[i] == 0 {
                continue
            }
            total = total + items[i]
        } finally {
            flushCountCont = flushCountCont + await flushCont()
        }
    }
    return total
}

resultCont = sumCont([]int32{0, 5, 9}).Result`
        let (program, _) = CompileAndRun(source, "gs1484_continue_")
        // Every iteration runs the finally (flush=3). i=0 continues (the finally
        // still runs), i=1 adds 5, i=2 adds 9 → total 14.
        Assert.Equal(14, ReadInt(program, "resultCont"))
        Assert.Equal(3, ReadInt(program, "flushCountCont"))
    }

    // (d) An early `return` from a try whose body itself contains an `await`
    //     before the return — exercises the funneled `leave` out of a protected
    //     region that holds a resume point (the goto-shaped exit path).
    @Fact
    func Return_After_Await_In_Try_Body_Through_Awaited_Finally() {
        let source = `package AsyncPatternCAwaitBodyPkg

import System
import System.Threading.Tasks

public var flushCountAwb = 0
public var resultAwb = 0

async func flushAwb() int32 {
    await Task.Delay(1)
    return 1
}

async func valueAwb(n int32) int32 {
    await Task.Delay(1)
    return n
}

async func computeAwb() int32 {
    try {
        let v = await valueAwb(41)
        return v + 1
    } finally {
        flushCountAwb = flushCountAwb + await flushAwb()
    }
}

resultAwb = computeAwb().Result`
        let (program, _) = CompileAndRun(source, "gs1484_awaitbody_")
        Assert.Equal(42, ReadInt(program, "resultAwb"))
        Assert.Equal(1, ReadInt(program, "flushCountAwb"))
    }

    // (e) Regression: an exception thrown through the awaited finally still runs
    //     the finally and propagates with its original message preserved.
    @Fact
    func Exception_Through_Awaited_Finally_Still_Runs_Finally_And_Propagates() {
        let source = `package AsyncPatternCThrowPkg

import System
import System.Threading.Tasks

public var flushCountThr = 0
public var caughtThr = ""

async func flushThr() int32 {
    await Task.Delay(1)
    return 1
}

async func throwThr() int32 {
    try {
        throw Exception("boomThr")
    } finally {
        flushCountThr = flushCountThr + await flushThr()
    }
    return -1
}

async func runThr() int32 {
    try {
        let v = await throwThr()
    } catch (e Exception) {
        caughtThr = e.Message
    }
    return 0
}

let _ = runThr().Result`
        let (program, _) = CompileAndRun(source, "gs1484_throw_")
        // The finally still runs (flush=1) and the exception propagates with its
        // original message intact.
        Assert.Equal(1, ReadInt(program, "flushCountThr"))
        Assert.Equal("boomThr", ReadString(program, "caughtThr"))
    }

    // (f) Nested try/finally with awaited finallys and an early return crossing
    //     BOTH — each finally must run, in inner-then-outer order.
    @Fact
    func Return_Crossing_Two_Awaited_Finallys_Runs_Both() {
        let source = `package AsyncPatternCNestedPkg

import System
import System.Threading.Tasks

public var innerCountNst = 0
public var outerCountNst = 0
public var orderNst = 0
public var resultNst = 0

async func flushNst() int32 {
    await Task.Delay(1)
    return 1
}

async func nestedNst(x int32) int32 {
    try {
        try {
            if x > 0 {
                return x
            }
        } finally {
            innerCountNst = innerCountNst + await flushNst()
            orderNst = orderNst * 10 + 1
        }
    } finally {
        outerCountNst = outerCountNst + await flushNst()
        orderNst = orderNst * 10 + 2
    }
    return -1
}

resultNst = nestedNst(7).Result`
        let (program, _) = CompileAndRun(source, "gs1484_nested_")
        Assert.Equal(7, ReadInt(program, "resultNst"))
        Assert.Equal(1, ReadInt(program, "innerCountNst"))
        Assert.Equal(1, ReadInt(program, "outerCountNst"))
        // Inner finally runs before the outer finally: 0 -> 1 -> 12.
        Assert.Equal(12, ReadInt(program, "orderNst"))
    }

    shared {
        private func ReadInt(program Type, fieldName string) int32 {
            let field = program.GetField(fieldName, BindingFlags.Public | BindingFlags.Static) ??
                throw InvalidOperationException("Field '$fieldName' not found.")
            return int32(field.GetValue(nil)!!)
        }

        private func ReadString(program Type, fieldName string) string? {
            let field = program.GetField(fieldName, BindingFlags.Public | BindingFlags.Static) ??
                throw InvalidOperationException("Field '$fieldName' not found.")
            return cast[string](field.GetValue(nil)!!)
        }

        private func CompileAndRun(source string, tempPrefix string)(Program Type, Assembly Assembly) {
            let assembly = CompileToAssembly(source, tempPrefix)
            let program = FindProgram(assembly)
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
            return (program, assembly)
        }

        private func FindProgram(assembly Assembly) Type {
            for t in assembly.GetTypes() {
                if t.Name == "<Program>" {
                    return t
                }
            }
            throw InvalidOperationException("No <Program> type found.")
        }

        private func CompileToAssembly(source string, tempPrefix string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory(tempPrefix).FullName
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
            return EmittedFixture.Load(outPath)
        }
    }
}

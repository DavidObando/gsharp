// <copyright file="AsyncConditionAwaitEmitTests.cs" company="GSharp">
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

/// Issue #1266: an `await` used inside an `if`/`while`/`for`/
/// `do-while` condition (or a `for` increment) previously leaked an
/// un-lowered `BoundAwaitExpression` to the emitter, which threw
/// `GS9998: Bound expression kind 'AwaitExpression' is not yet supported by
/// the emitter.` The statement binder and the Lowerer desugar every branch
/// and loop into label/goto form, so the condition await lives inside a
/// `BoundConditionalGotoStatement`; the spiller now spills those awaits the
/// same way it already handled `let`/`return` initializers. Each test
/// here compiles the offending shape, IL-verifies the emitted assembly, and runs
/// it to assert the correct branch/iteration behaviour.
open class AsyncConditionAwaitEmitTests {
    @Fact
    func Await_In_If_Condition_Takes_Correct_Branch() {
        let source = `package P

import System.Threading.Tasks

class C {
    init() {}

    async func F(tk Task[int32]) int32 {
        if (await tk) != 5 { return 1 }
        return 0
    }
}

public var whenEqual = -1
public var whenNotEqual = -1
let c = C()
whenEqual = c.F(Task.FromResult(5)).Result
whenNotEqual = c.F(Task.FromResult(9)).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        // (await 5) != 5 is false -> falls through -> returns 0.
        Assert.Equal(0, ReadInt(program, "whenEqual"))
        // (await 9) != 5 is true -> returns 1.
        Assert.Equal(1, ReadInt(program, "whenNotEqual"))
    }

    @Fact
    func Await_In_While_Condition_Reevaluates_Each_Iteration() {
        let source = `package P

import System.Threading.Tasks

class C {
    init() {}

    async func SumBelow(n int32) int32 {
        var i = 0
        var sum = 0
        while await Task.FromResult(i) < n {
            sum = sum + i
            i = i + 1
        }
        return sum
    }
}

public var sum = -1
let c = C()
sum = c.SumBelow(5).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        // 0 + 1 + 2 + 3 + 4 == 10; the awaited condition must run 6 times.
        Assert.Equal(10, ReadInt(program, "sum"))
    }

    @Fact
    func Await_In_For_Condition_Reevaluates_Each_Iteration() {
        let source = `package P

import System.Threading.Tasks

class C {
    init() {}

    async func ForSum(n int32) int32 {
        var sum = 0
        for var i = 0; await Task.FromResult(i) < n; i = i + 1 {
            sum = sum + i
        }
        return sum
    }
}

public var sum = -1
let c = C()
sum = c.ForSum(4).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        // 0 + 1 + 2 + 3 == 6.
        Assert.Equal(6, ReadInt(program, "sum"))
    }

    @Fact
    func Await_In_Both_Operands_Of_Condition() {
        let source = `package P

import System.Threading.Tasks

class C {
    init() {}

    async func Compare(a Task[int32], b Task[int32]) int32 {
        if (await a) < (await b) { return 100 }
        return 200
    }
}

public var less = -1
public var greater = -1
let c = C()
less = c.Compare(Task.FromResult(1), Task.FromResult(2)).Result
greater = c.Compare(Task.FromResult(3), Task.FromResult(2)).Result`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.Equal(100, ReadInt(program, "less"))
        Assert.Equal(200, ReadInt(program, "greater"))
    }

    @Fact
    func Await_Right_Operand_Of_LogicalAnd_Is_Short_Circuited() {
        let source = `package P

import System.Threading.Tasks

public var rightRuns = 0

func rightTask() Task[bool] {
    rightRuns = rightRuns + 1
    return Task.FromResult(true)
}

class C {
    init() {}

    async func AndShort(left bool) int32 {
        if left && (await rightTask()) { return 1 }
        return 0
    }
}

public var shortResult = -1
public var shortRuns = -1
public var fullResult = -1
public var fullRuns = -1
let c = C()
rightRuns = 0
shortResult = c.AndShort(false).Result
shortRuns = rightRuns
rightRuns = 0
fullResult = c.AndShort(true).Result
fullRuns = rightRuns`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        // left=false short-circuits: the right operand (and its await) must not run.
        Assert.Equal(0, ReadInt(program, "shortResult"))
        Assert.Equal(0, ReadInt(program, "shortRuns"))
        // left=true forces the right operand: the await runs exactly once.
        Assert.Equal(1, ReadInt(program, "fullResult"))
        Assert.Equal(1, ReadInt(program, "fullRuns"))
    }

    @Fact
    func Await_Right_Operand_Of_LogicalOr_Is_Short_Circuited() {
        let source = `package P

import System.Threading.Tasks

public var rightRuns = 0

func rightTask() Task[bool] {
    rightRuns = rightRuns + 1
    return Task.FromResult(false)
}

class C {
    init() {}

    async func OrShort(left bool) int32 {
        if left || (await rightTask()) { return 1 }
        return 0
    }
}

public var shortResult = -1
public var shortRuns = -1
public var fullResult = -1
public var fullRuns = -1
let c = C()
rightRuns = 0
shortResult = c.OrShort(true).Result
shortRuns = rightRuns
rightRuns = 0
fullResult = c.OrShort(false).Result
fullRuns = rightRuns`
        let assembly = CompileAndInvokeEntry(source)
        let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
        // left=true short-circuits: the right operand (and its await) must not run.
        Assert.Equal(1, ReadInt(program, "shortResult"))
        Assert.Equal(0, ReadInt(program, "shortRuns"))
        // left=false forces the right operand: the await runs, condition stays false.
        Assert.Equal(0, ReadInt(program, "fullResult"))
        Assert.Equal(1, ReadInt(program, "fullRuns"))
    }

    shared {
        private func ReadInt(program Type, fieldName string) int32 {
            let field FieldInfo? = program.GetField(
                fieldName,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(field)
            return int32(field!!.GetValue(nil)!!)
        }

        private func CompileAndInvokeEntry(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_async_cond_emit_").FullName
            try {
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
                Assert.NotNull(entry)
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
                return assembly
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

// <copyright file="AsyncSpilledAwaitInTryEmitTests.cs" company="GSharp">
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

/// Regression tests for a spilled `await` (an await appearing as a
/// sub-expression, e.g. a call argument) nested inside a `try` region —
/// including the `try`/`finally` that `using` lowers to.
///
/// The (cref:GSharp.Core.CodeAnalysis.Lowering.Async.SpillSequenceSpiller)
/// previously treated `BoundTryStatement` as an await-free leaf and never
/// descended into the protected block, so an await such as `F(await G())`
/// inside a `try`/`using` body was never lifted to statement
/// top-level. That left a raw `BoundAwaitExpression` in the synthesized
/// `MoveNext()` body, which the emitter rejected with
/// `GS9998: Bound expression kind 'AwaitExpression' is not yet supported by
/// the emitter.` These tests assert the program now emits, verifies, and
/// runs to the correct result.
open class AsyncSpilledAwaitInTryEmitTests {
    @Fact
    func Spilled_Await_Inside_Using_Block_Emits_And_Runs() {
        let source = `package P

import System
import System.Threading.Tasks

class Probe : IDisposable {
    init() {}
    func Dispose() {}
}

func AddAsync(a int32, b int32) Task[int32] {
    return Task.FromResult(a + b)
}

func Sum(a int32, b int32) int32 {
    return a + b
}

async func Compute() int32 {
    var total = 0
    using let p = Probe()
    total = Sum(await AddAsync(1, 2), await AddAsync(3, 4))
    return total
}

public var result = 0
result = Compute().Result`
        let assembly = CompileToAssembly(source)
        let program = assembly.GetType("<Program>") ?? FindProgram(assembly)
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
        Assert.Equal(10, int32(resultField!!.GetValue(nil)!!))
    }

    @Fact
    func Spilled_Await_Inside_TryCatch_Emits_And_Runs() {
        let source = `package P

import System
import System.Threading.Tasks

func ValueAsync(n int32) Task[int32] {
    return Task.FromResult(n)
}

func Sum(a int32, b int32) int32 {
    return a + b
}

async func Compute() int32 {
    var total = 0
    try {
        total = Sum(await ValueAsync(40), await ValueAsync(2))
    } catch (e Exception) {
        total = -1
    }
    return total
}

public var result = 0
result = Compute().Result`
        let assembly = CompileToAssembly(source)
        let program = FindProgram(assembly)
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

    shared {
        private func FindProgram(assembly Assembly) Type {
            for t in assembly.GetTypes() {
                if t.Name == "<Program>" {
                    return t
                }
            }
            throw InvalidOperationException("No <Program> type found.")
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_async_spill_try_emit_").FullName
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

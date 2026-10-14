// <copyright file="Issue2283ChannelReceiveSubExpressionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2283 was reported as an `ilverify` CRASH
/// (`IndexOutOfRangeException` in
/// `Internal.IL.ILImporter.MarkPredecessorWithLowerOffset`) compiling
/// control-flow-heavy Oahu.SystemManagement code (nested loops parsing shell
/// output). The private source that triggered the crash is not available, and
/// an extensive search for a minimal repro — nested/labeled loops with
/// `break`/`continue`, deeply nested `try`/`catch`/
/// `finally`, pattern-switch statements and expressions, `if let`/
/// `guard let`, `using let`/`defer`, very long methods forcing
/// long-form branch encoding, goroutines and `select` — did not reproduce
/// that exact crash. gsc's branch emission goes through
/// `System.Reflection.Metadata`'s `InstructionEncoder`/
/// `ControlFlowBuilder`, which auto-sizes and fixes up branch targets, so
/// a short-branch-overflow or manual offset miscalculation was ruled out as
/// the likely cause.
///
/// That search did surface a real, confirmed, closely related IL-emission
/// stack-balance bug in the SAME problem domain (protected-region placement
/// relative to the evaluation stack, the class of bug
/// `MarkPredecessorWithLowerOffset`'s crash strongly implies): a channel
/// receive expression (`<-ch`) emitted its `try`/`catch`
/// (translating a closed-channel exception into `default(T)`) INLINE at
/// its point of evaluation, unconditionally. Per ECMA-335 III.3.47 a
/// protected region must be entered with an EMPTY evaluation stack. When the
/// receive is a sub-expression of a larger expression — e.g.
/// `total = total + <-ch`, or inside a loop condition/call argument —
/// earlier operands are already on the stack when the try region opens,
/// producing invalid IL: ilverify reports `TryNonEmptyStack` and
/// `StackUnderflow`, and the JIT throws
/// (cref:InvalidProgramException) at run time.
///
/// The fix follows the existing "stackalloc spilling" pattern from Issue
/// #1522: every `BoundChannelReceiveExpression` in a statement is
/// materialised — its `try`/`catch` executed and result stored to a
/// pre-allocated local — at the START of that statement's emission, when the
/// stack is guaranteed empty (`MaterializeSpilledChannelReceives` in
/// `MethodBodyEmitter.cs`, called from `EmitStatement`). The
/// original expression-position emit (`EmitChannelReceiveExpression` in
/// `MethodBodyEmitter.Calls.cs`) then just loads that already-computed
/// result local instead of re-emitting the try/catch in place.
///
/// These tests compile, ilverify, and run the exact failure shapes: a
/// channel-receive as an operand of `+`, and the same pattern nested
/// inside a loop with `continue`/`break` (mirroring the
/// control-flow-heavy shape from the original report).
open class Issue2283ChannelReceiveSubExpressionEmitTests {
    @Fact
    func ChannelReceive_AsAdditionOperand_VerifiesAndRuns() {
        const source = `package Issue2283.AddOperand
import System

let ch = chan[int32](1)
ch <- 7
var total = 0
total = total + <-ch
Console.WriteLine(total)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func ChannelReceive_InLoopWithBreakAndContinue_VerifiesAndRuns() {
        const source = `package Issue2283.LoopBreakContinue
import System

let ch = chan[int32](5)
for var i = 0; i < 5; i++ {
    ch <- i
}
var total = 0
for var i = 0; i < 5; i++ {
    if i == 2 {
        continue
    }
    total = total + <-ch
    if total > 100 {
        break
    }
}
Console.WriteLine(total)`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    @Fact
    func ChannelReceive_AsCallArgument_VerifiesAndRuns() {
        const source = `package Issue2283.CallArgument
import System

func Sum2283(a int32, b int32) int32 -> a + b

let ch = chan[int32](1)
ch <- 5
Console.WriteLine(Sum2283(10, <-ch))`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func ChannelReceive_StatementRoot_StillVerifiesAndRuns() {
        // Regression guard: a bare `let x = <-ch` (already at an empty-stack
        // root position) is unaffected by the spilling fix and keeps working.
        const source = `package Issue2283.StatementRoot
import System

let ch = chan[int32](1)
ch <- 3
let v = <-ch
Console.WriteLine(v)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2283_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

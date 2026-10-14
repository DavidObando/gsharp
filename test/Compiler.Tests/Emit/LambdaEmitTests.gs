// <copyright file="LambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Phase 4 emit-parity tests for function literals (Phase 4.7) — emit
/// commits E1 (no-capture lambdas + indirect calls) and E2 (closures with
/// snapshot-by-value captured variables).
///
/// Each function literal is lowered to a synthesized static method on the
/// owning package's `<Program>` type, and the literal site emits
/// `ldnull / ldftn / newobj Func|Action::.ctor(object, IntPtr)`. An
/// indirect call evaluates the target delegate value and dispatches via
/// `callvirt Invoke`. Capture-bearing literals (E2) are lowered into a
/// synthesized sealed closure class with one field per capture and an
/// instance `Invoke` method; the literal site emits
/// `newobj / (dup + load + stfld)* / dup / ldftn / newobj Func|Action::.ctor`.
/// Closure tests live in (cref:ClosureEmitTests).
open class LambdaEmitTests {
    @Fact
    func FuncIntInt_AssignedAndInvoked() {
        let source = `package P
import System

var inc = func(x int32) int32 { return x + 1 }
Console.WriteLine(inc(10))`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}", output)
    }

    @Fact
    func ActionNoArgs_AssignedAndInvoked() {
        let source = `package P
import System

var greet = func() { Console.WriteLine("hi") }
greet()`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func FuncTwoArgs_AssignedAndInvoked() {
        let source = `package P
import System

var add = func(a int32, b int32) int32 { return a + b }
Console.WriteLine(add(3, 4))`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func FuncNineArgs_AssignedAndInvoked() {
        let source = `package P
import System

var sum = func(a int32, b int32, c int32, d int32, e int32, f int32, g int32, h int32, i int32) int32 {
    return a + b + c + d + e + f + g + h + i
}
Console.WriteLine(sum(1, 2, 3, 4, 5, 6, 7, 8, 9))`
        let output = CompileAndRun(source)
        Assert.Equal("45${Environment.NewLine}", output)
    }

    @Fact
    func FuncSixteenArgs_AssignedAndInvoked() {
        let source = `package P
import System

var last = func(
    a int32, b int32, c int32, d int32,
    e int32, f int32, g int32, h int32,
    i int32, j int32, k int32, l int32,
    m int32, n int32, o int32, p int32) int32 {
    return p
}
Console.WriteLine(last(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16))`
        let output = CompileAndRun(source)
        Assert.Equal("16${Environment.NewLine}", output)
    }

    @Fact
    func IndirectCall_ThroughFunctionTypedParameter() {
        let source = `package P
import System

func apply(f func(int32) int32, x int32) int32 { return f(x) }

var dbl = func(x int32) int32 { return x * 2 }
Console.WriteLine(apply(dbl, 21))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func ClosureCaptures_MakeAdder() {
        // Phase 4 E2 (closures): captured outer variable lowered to a
        // synthesized closure class field via snapshot-by-value at literal
        // evaluation time. This test pins that emitted behavior.
        let source = `package P
import System

func makeAdder(n int32) func(int32) int32 {
  return func(x int32) int32 { return x + n }
}

var addN = makeAdder(5)
Console.WriteLine(addN(10))`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_lambda_emit_").FullName
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
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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

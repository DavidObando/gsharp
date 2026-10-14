// <copyright file="GenericFunctionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Emit coverage for generic function.
/// Traceability: ADR-0004.
open class GenericFunctionEmitTests {
    @Fact
    func GenericIdentity_InferredInt() {
        let source = `package P
import System

func Identity[T any](x T) T { return x }
Console.WriteLine(Identity(42))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func GenericIdentity_ExplicitString() {
        let source = `package P
import System

func Identity[T any](x T) T { return x }
Console.WriteLine(Identity[string]("hi"))`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func GenericIdentity_InferredBool() {
        let source = `package P
import System

func Identity[T any](x T) T { return x }
Console.WriteLine(Identity(true))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func GenericTwoParameters_FirstWins() {
        let source = `package P
import System

func First[T any, U any](a T, b U) T { return a }
Console.WriteLine(First(10, "ignored"))`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}", output)
    }

    @Fact
    func GenericTwoParameters_SecondWins() {
        let source = `package P
import System

func Second[T any, U any](a T, b U) U { return b }
Console.WriteLine(Second("ignored", 99))`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func GenericRoundTrip_StoredAndReused() {
        // Substituted return is int; the call site unboxes, the assignment
        // stores into an int-typed local, and arithmetic on it works.
        let source = `package P
import System

func Identity[T any](x T) T { return x }

var n = Identity(20)
Console.WriteLine(n + 22)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func GenericVoidDelegate_DynamicInvoke_PopsResult_Issue418() {
        // Issue #418 (P1-6): an erased void-returning delegate (func(T) with
        // no return) is invoked via System.Delegate.DynamicInvoke which always
        // returns object. Without an explicit Pop the boxed result lingers on
        // the stack until the next ret/leave, producing invalid IL that
        // refuses to load.
        let source = `package P
import System

func Run[T any](x T, f func(T)) { f(x) }
Run(7, func(n int32) { Console.WriteLine(n) })
Run("hi", func(s string) { Console.WriteLine(s) })`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func GenericVoidDelegate_DynamicInvoke_CalledInLoop_Issue418() {
        // Repeated invocation makes the stack-leak bug deterministic: each
        // iteration would push an object that survives across the back-edge.
        let source = `package P
import System

func Repeat[T any](x T, n int32, f func(T)) {
    for var i = 0; i < n; i = i + 1 {
        f(x)
    }
}
Repeat(42, 3, func(v int32) { Console.WriteLine(v) })`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_generic_emit_").FullName
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

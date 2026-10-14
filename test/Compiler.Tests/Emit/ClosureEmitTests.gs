// <copyright file="ClosureEmitTests.cs" company="GSharp">
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

/// Phase 4 emit-parity tests for closures (Phase 4.7) — emit commit E2.
///
/// Each capture-bearing function literal is lowered to a synthesized
/// internal sealed CLR class with one public field per captured variable
/// and an instance `Invoke` method holding the rewritten body. The
/// literal site emits
/// `newobj ctor / (dup; <load capture>; stfld field)* / ldftn Invoke /
/// newobj Func|Action::.ctor(object, IntPtr)`.
///
/// Capture semantics (issue #523) are by reference over the variable cell —
/// matching Go and C#. Captured locals/parameters are hoisted into a
/// per-variable box class by the `CaptureBoxingRewriter` lowering pass;
/// the closure class holds a reference to the box, so writes inside the
/// lambda and writes in the outer scope are mutually visible.
open class ClosureEmitTests {
    @Fact
    func SingleIntCapture() {
        let source = `package P
import System

func makeAdder(n int32) func(int32) int32 {
  return func(x int32) int32 { return x + n }
}

var addN = makeAdder(7)
Console.WriteLine(addN(35))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func MultipleCaptures() {
        let source = `package P
import System

func makeLinear(a int32, b int32) func(int32) int32 {
  return func(x int32) int32 { return a * x + b }
}

var f = makeLinear(3, 4)
Console.WriteLine(f(10))`
        let output = CompileAndRun(source)
        Assert.Equal("34${Environment.NewLine}", output)
    }

    @Fact
    func StringCapture() {
        let source = `package P
import System

func makeGreeter(greeting string) func(string) string {
  return func(name string) string { return greeting + ", " + name + "!" }
}

var hello = makeGreeter("Hello")
Console.WriteLine(hello("world"))`
        let output = CompileAndRun(source)
        Assert.Equal("Hello, world!${Environment.NewLine}", output)
    }

    @Fact
    func StatefulCounter_LambdaMutationPersistsAcrossCalls() {
        // Issue #523: `c` is captured by reference. Each call to the returned
        // lambda updates the shared cell, so consecutive invocations see the
        // accumulated state. Two separate `makeCounter` calls still get
        // independent cells (covered by `CaptureAcrossSeparateCalls_AreIndependent`).
        let source = `package P
import System

func makeCounter(start int32) func(int32) int32 {
  var c = start
  return func(x int32) int32 {
    c = c + 1
    return x + c
  }
}

var addN = makeCounter(10)
Console.WriteLine(addN(0))
Console.WriteLine(addN(0))`
        let output = CompileAndRun(source)
        // First call: shared c becomes 11, returns 11.
        // Second call: shared c becomes 12, returns 12.
        Assert.Equal("11${Environment.NewLine}12${Environment.NewLine}", output)
    }

    @Fact
    func CaptureAcrossSeparateCalls_AreIndependent() {
        let source = `package P
import System

func makeAdder(n int32) func(int32) int32 {
  return func(x int32) int32 { return x + n }
}

var add5 = makeAdder(5)
var add100 = makeAdder(100)
Console.WriteLine(add5(1))
Console.WriteLine(add100(1))`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}101${Environment.NewLine}", output)
    }

    @Fact
    func CapturedPrivateNestedStructInSharedMethodRuns() {
        let source = `package Issue4526
import System

class Outer {
    private data struct Hidden(Value int32) {
    }

    shared {
        private func Read(hidden Hidden) int32 {
            let read = () -> hidden.Value
            return read()
        }

        func Run() int32 {
            return Read(Hidden(42))
        }
    }
}

func Main() {
    Console.WriteLine(Outer.Run())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func CapturedPrivateNestedStructInGenericOwnerRuns() {
        let source = `package Issue4526Generic
import System

class Outer[T] {
    private data struct Hidden(Value int32) {
    }

    private func Read(hidden Hidden) int32 {
        let read = () -> hidden.Value
        return read()
    }

    func Run() int32 {
        return Read(Hidden(43))
    }
}

func Main() {
    Console.WriteLine(Outer[string]().Run())
}`
        let output = CompileAndRun(source)
        Assert.Equal("43${Environment.NewLine}", output)
    }

    @Fact
    func CapturedPrivateNestedStructInDeepGenericOwnerRuns() {
        let source = `package Issue4526DeepGeneric
import System

class Outer[T] {
    func RunInner[U]() int32 {
        return Inner[U]().Run()
    }

    class Inner[U] {
        private data struct Hidden(Value int32) {
        }

        private func Read(hidden Hidden) int32 {
            let read = () -> hidden.Value
            return read()
        }

        func Run() int32 {
            return Read(Hidden(44))
        }
    }
}

func Main() {
    Console.WriteLine(Outer[string]().RunInner[bool]())
}`
        let output = CompileAndRun(source)
        Assert.Equal("44${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_closure_emit_").FullName
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
                // Drop a minimal runtimeconfig so `dotnet exec` can host the .dll.
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

// <copyright file="Issue1531VoidDelegateOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1531 — a void-returning delegate / method-group argument wrongly made
/// a value-returning `(...)->TResult` (type-parameter-return) overload
/// applicable (generic inference bound `TResult := void`), so it competed
/// with the intended `(...)->void` overload and gsc reported a spurious
/// `GS0266` ambiguity. C# resolves this to the void overload unambiguously
/// because a void-returning delegate cannot bind `Func<…,TResult>`.
///
/// The fix refuses to infer any method type parameter from a `void` source,
/// which prunes the `(...)->TResult` overload for a void argument, and
/// substitutes inferred type arguments into open delegate parameters during
/// Phase-2 scoring so a genuinely value-returning argument still selects the
/// `(...)->TResult` overload (the control) instead of tying.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue1531VoidDelegateOverloadEmitTests {
    @Fact
    func EndToEnd_VoidMethodGroup_Arity1_PicksVoidOverload() {
        const source = `package i1531mg1
import System
class Ext {
    shared {
        func Run[T1](d (T1) -> void, p1 T1) { d(p1) }
        func Run[T1, TResult](d (T1) -> TResult, p1 T1) TResult { return d(p1) }
    }
}
func Sink(x int32) { Console.WriteLine(x) }
func Main() { Ext.Run(Sink, 42) }`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_VoidMethodGroup_Arity0_PicksVoidOverload() {
        const source = `package i1531mg0
import System
class Ext {
    shared {
        func Run(d () -> void) { d() }
        func Run[TResult](d () -> TResult) TResult { return d() }
    }
}
func Sink() { Console.WriteLine("zero") }
func Main() { Ext.Run(Sink) }`
        Assert.Equal("zero${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_VoidMethodGroup_Arity2_PicksVoidOverload() {
        const source = `package i1531mg2
import System
class Ext {
    shared {
        func Run[T1, T2](d (T1, T2) -> void, p1 T1, p2 T2) { d(p1, p2) }
        func Run[T1, T2, TResult](d (T1, T2) -> TResult, p1 T1, p2 T2) TResult { return d(p1, p2) }
    }
}
func Sink(a int32, b int32) { Console.WriteLine(a + b) }
func Main() { Ext.Run(Sink, 1, 2) }`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_VoidMethodGroup_Arity3_PicksVoidOverload() {
        const source = `package i1531mg3
import System
class Ext {
    shared {
        func Run[T1, T2, T3](d (T1, T2, T3) -> void, p1 T1, p2 T2, p3 T3) { d(p1, p2, p3) }
        func Run[T1, T2, T3, TResult](d (T1, T2, T3) -> TResult, p1 T1, p2 T2, p3 T3) TResult { return d(p1, p2, p3) }
    }
}
func Sink(a int32, b int32, c int32) { Console.WriteLine(a + b + c) }
func Main() { Ext.Run(Sink, 1, 2, 3) }`
        Assert.Equal("6${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_VoidLambda_PicksVoidOverload() {
        const source = `package i1531lam
import System
class Ext {
    shared {
        func Run[T1](d (T1) -> void, p1 T1) { d(p1) }
        func Run[T1, TResult](d (T1) -> TResult, p1 T1) TResult { return d(p1) }
    }
}
func Main() { Ext.Run((x int32) -> { Console.WriteLine(x) }, 42) }`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_VoidMethodGroup_InstanceMethod_PicksVoidOverload() {
        const source = `package i1531inst
import System
class Ext {
    func Run[T1](d (T1) -> void, p1 T1) { d(p1) }
    func Run[T1, TResult](d (T1) -> TResult, p1 T1) TResult { return d(p1) }
}
func Sink(x int32) { Console.WriteLine(x) }
func Main() {
    var e = Ext()
    e.Run(Sink, 7)
    e.Run((x int32) -> { Console.WriteLine(x + 100) }, 7)
}`
        Assert.Equal("7${Environment.NewLine}107${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_ValueMethodGroup_Control_PicksTResultOverload() {
        const source = `package i1531valmg
import System
class Ext {
    shared {
        func Run[T1](d (T1) -> void, p1 T1) { d(p1) }
        func Run[T1, TResult](d (T1) -> TResult, p1 T1) TResult { return d(p1) }
    }
}
func Val(x int32) int32 { return x * 2 }
func Main() { Console.WriteLine(Ext.Run(Val, 10)) }`
        Assert.Equal("20${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_ValueLambda_Control_PicksTResultOverload() {
        const source = `package i1531vallam
import System
class Ext {
    shared {
        func Run[T1](d (T1) -> void, p1 T1) { d(p1) }
        func Run[T1, TResult](d (T1) -> TResult, p1 T1) TResult { return d(p1) }
    }
}
func Main() { Console.WriteLine(Ext.Run((x int32) -> x * 3, 4)) }`
        Assert.Equal("12${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_ValueLambda_ToVoidOnlyParameter_DiscardStillWorks() {
        const source = `package i1531discard
import System
class Ext {
    shared {
        func RunVoid[T1](d (T1) -> void, p1 T1) { d(p1) }
    }
}
func Main() {
    Ext.RunVoid((x int32) -> { Console.WriteLine(x) }, 5)
    Ext.RunVoid((x int32) -> x * 2, 9)
    Console.WriteLine("done")
}`
        Assert.Equal("5${Environment.NewLine}done${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1531_exe_").FullName
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

// <copyright file="Issue567ClockHolderRegressionTests.cs" company="GSharp">
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

/// Regression coverage for issue #567: capturing a reference-type local in a
/// closure inside a class method, then reading or writing a field on that
/// local, must compile correctly and emit valid IL. The underlying bug was a
/// stale `program.Functions[lambdaSymbol]` entry after the outer
/// function's body was rewritten by `CaptureBoxingRewriter`, combined
/// with a missing `BoundFieldAssignmentExpression` rewrite for boxed
/// receivers. Each test compiles end-to-end, verifies with `ilverify`,
/// and asserts on runtime stdout.
open class Issue567ClockHolderRegressionTests {
    /// The exact repro from issue #567: capture a reference-type local in a
    /// class method, set a field on it, then read that field from a closure.
    @Fact
    func ClockHolder_FieldRead_FromClosureInClassMethod() {
        let source = `package Probe
import System

class ClockHolder {
    var Value int32
    init() {}
}

class GS9998_Probe {
    init() {}
    func Run() int32 {
        var clock = ClockHolder()
        clock.Value = 42
        var getter = func() int32 { return clock.Value }
        let v = getter()
        return v
    }
}

var p = GS9998_Probe()
Console.WriteLine(p.Run())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    /// Closure mutates a field on the captured reference-type local; the
    /// outer scope observes the mutation.
    @Fact
    func ClockHolder_FieldWrite_FromClosureInClassMethod() {
        let source = `package Probe
import System

class ClockHolder {
    var Value int32
    init() {}
}

class Probe2 {
    init() {}
    func Run() int32 {
        var clock = ClockHolder()
        clock.Value = 10
        var setter = func(x int32) { clock.Value = x }
        setter(99)
        return clock.Value
    }
}

var p = Probe2()
Console.WriteLine(p.Run())`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    /// Closure adds to a captured list; outer scope observes the addition.
    @Fact
    func ListMutation_FromClosureInClassMethod() {
        let source = `package Probe
import System
import System.Collections.Generic

class ListProbe {
    init() {}
    func Run() int32 {
        var items = List[int32]()
        var adder = func(x int32) { items.Add(x) }
        adder(1)
        adder(2)
        adder(3)
        return items.Count
    }
}

var p = ListProbe()
Console.WriteLine(p.Run())`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    /// Closure adds to a captured dictionary; outer scope reads the count.
    @Fact
    func DictionaryMutation_FromClosureInClassMethod() {
        let source = `package Probe
import System
import System.Collections.Generic

class DictProbe {
    init() {}
    func Run() int32 {
        var d = Dictionary[string, int32]()
        var put = func(k string, v int32) { d.Add(k, v) }
        put("a", 1)
        put("b", 2)
        return d.Count
    }
}

var p = DictProbe()
Console.WriteLine(p.Run())`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    /// Two lambdas in the same scope both capture the same reference-type
    /// local and observe each other's field writes through the shared box.
    @Fact
    func MultipleClosures_ShareCapturedReferenceLocal() {
        let source = `package Probe
import System

class Counter {
    var N int32
    init() {}
}

class MultiProbe {
    init() {}
    func Run() int32 {
        var c = Counter()
        var inc = func() { c.N = c.N + 1 }
        var read = func() int32 { return c.N }
        inc()
        inc()
        inc()
        return read()
    }
}

var p = MultiProbe()
Console.WriteLine(p.Run())`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    /// Nested closure: outer lambda captures a reference-type local; inner
    /// lambda (declared inside outer's body) also reads a field on it.
    @Fact
    func NestedClosure_CapturesCapturedReferenceLocal() {
        let source = `package Probe
import System

class Holder {
    var Val int32
    init() {}
}

class NestProbe {
    init() {}
    func Run() int32 {
        var h = Holder()
        h.Val = 7
        var outer = func() func() int32 {
            var inner = func() int32 { return h.Val }
            return inner
        }
        var f = outer()
        return f()
    }
}

var p = NestProbe()
Console.WriteLine(p.Run())`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    /// Top-level function variant: closure captures a reference-type local
    /// in a package-level function (not inside a class), confirming the fix
    /// doesn't regress the simpler non-class-method path.
    @Fact
    func ClosureInsideClassMethod_OnStatic() {
        let source = `package Probe
import System

class Box {
    var X int32
    init() {}
}

func Go() int32 {
    var b = Box()
    b.X = 55
    var read = func() int32 { return b.X }
    return read()
}

Console.WriteLine(Go())`
        let output = CompileAndRun(source)
        Assert.Equal("55${Environment.NewLine}", output)
    }

    /// Oahu-inspired shape: a class with a mutable state field, a method
    /// that captures it in a closure and mutates through the closure, then
    /// observes the mutation from the outer scope.
    @Fact
    func OahuRepro_CtrlCStateShape() {
        let source = `package Probe
import System

class State {
    var Running bool
    init() {}
}

class Controller {
    init() {}
    func Execute() string {
        var state = State()
        state.Running = true
        var stop = func() { state.Running = false }
        stop()
        if state.Running {
            return "still running"
        }
        return "stopped"
    }
}

var c = Controller()
Console.WriteLine(c.Execute())`
        let output = CompileAndRun(source)
        Assert.Equal("stopped${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_567_").FullName
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

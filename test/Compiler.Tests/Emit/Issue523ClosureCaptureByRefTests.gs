// <copyright file="Issue523ClosureCaptureByRefTests.cs" company="GSharp">
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

/// Regression coverage for issue #523: function literals must capture their
/// enclosing locals/parameters by reference (over the variable cell), not
/// by value at literal-construction time. Each test compiles an end-to-end
/// program, runs it with `dotnet exec`, runs `ilverify` against
/// the emitted assembly, and asserts on stdout.
open class Issue523ClosureCaptureByRefTests {
    /// The exact repro from the issue body: a captured value-type local that
    /// is reassigned after the lambda is constructed must be visible to the
    /// lambda body.
    @Fact
    func IssueRepro_ValueTypeLocal_LambdaSeesPostConstructionWrite() {
        let source = `package P
import System

func probe() {
    var n = 1
    var getter = func() int32 { return n }
    n = 99
    Console.WriteLine(getter())
}

probe()`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func TwoLambdasShareCapturedCell() {
        let source = `package P
import System

func main2() {
    var n = 1
    var read = func() int32 { return n }
    var write = func(x int32) { n = x }
    Console.WriteLine(read())
    write(42)
    Console.WriteLine(read())
    n = 7
    Console.WriteLine(read())
}

main2()`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}42${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func CapturedParameter_LambdaObservesOuterWrites() {
        let source = `package P
import System

func makeCounter(start int32) func() int32 {
    var n = start
    var inc = func() int32 {
        n = n + 1
        return n
    }
    // Pre-bump the param-derived local: the lambda must see the
    // update because both this scope and the lambda share the
    // same cell.
    n = n + 10
    return inc
}

var c = makeCounter(0)
Console.WriteLine(c())
Console.WriteLine(c())
Console.WriteLine(c())`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}12${Environment.NewLine}13${Environment.NewLine}", output)
    }

    @Fact
    func NestedLambda_InnerSeesOuterReassignment() {
        let source = `package P
import System

func make() func() func() int32 {
    var n = 0
    var outer = func() func() int32 {
        var inner = func() int32 { return n }
        return inner
    }
    n = 5
    return outer
}

var g = make()
var f = g()
Console.WriteLine(f())`
        let output = CompileAndRun(source)
        // n is shared through the box; the inner lambda is built when outer
        // runs, but it still resolves n through the same cell that the
        // outermost write `n = 5` touched.
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func CaptureSurvivesAcrossCallBoundary_LambdaMutatesAfterRoundTrip() {
        let source = `package P
import System

func bumpTwice(f func()) {
    f()
    f()
}

func main3() {
    var n = 10
    var inc = func() { n = n + 1 }
    bumpTwice(inc)
    bumpTwice(inc)
    Console.WriteLine(n)
}

main3()`
        let output = CompileAndRun(source)
        Assert.Equal("14${Environment.NewLine}", output)
    }

    @Fact
    func BoolCapture_LambdaSeesFlip() {
        let source = `package P
import System

func main4() {
    var flag = false
    var read = func() bool { return flag }
    Console.WriteLine(read())
    flag = true
    Console.WriteLine(read())
}

main4()`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func ReferenceTypeCapture_LambdaSeesReassignment() {
        let source = `package P
import System
import System.Text

func main5() {
    var sb = StringBuilder()
    sb.Append("first")
    var read = func() string { return sb.ToString() }
    Console.WriteLine(read())
    sb = StringBuilder()
    sb.Append("second")
    Console.WriteLine(read())
}

main5()`
        let output = CompileAndRun(source)
        Assert.Equal("first${Environment.NewLine}second${Environment.NewLine}", output)
    }

    @Fact
    func CapturedLocalInsideLoop_FreshCellPerIteration() {
        // Each iteration of a `for…in` body re-runs the inner `var`
        // declaration, so the box allocation runs per-iteration — matching
        // C# semantics for a variable declared inside a loop body. Capture
        // two lambdas from successive iterations and verify each carries
        // its own cell.
        let source = `package P
import System

class Holder {
    public var First func() int32
    public var Second func() int32
    init() {}
}

func main6() {
    var h = Holder()
    for i in []int32{0, 1} {
        var n = i
        var f = func() int32 { return n }
        if i == 0 {
            h.First = f
        } else {
            h.Second = f
        }
    }
    var a = h.First
    var b = h.Second
    Console.WriteLine(a())
    Console.WriteLine(b())
}

main6()`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}1${Environment.NewLine}", output)
    }

    @Fact
    func GlobalVar_ReadsLiveValueFromStaticField() {
        // Issue #523 (side fix): globals are addressable as static fields,
        // so the lambda must read them live (ldsfld) rather than snapshot
        // them into a closure field at literal-construction time.
        let source = `package P
import System

var g = 1

func makeReader() func() int32 {
    return func() int32 { return g }
}

var r = makeReader()
Console.WriteLine(r())
g = 99
Console.WriteLine(r())`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}99${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_523_").FullName
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

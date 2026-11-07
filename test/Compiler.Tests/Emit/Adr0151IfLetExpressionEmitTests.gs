// <copyright file="Adr0151IfLetExpressionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Threading.Tasks
import Xunit

/// ADR-0151 — end-to-end emit coverage for the value-producing
/// `if let` expression. Each test compiles via in-process `gsc`,
/// IL-verifies the emitted PE, then executes the assembly under
/// `dotnet exec` and asserts captured stdout. The lowering reuses the
/// ADR-0064 `BoundConditionalExpression` / `BoundBlockExpression`
/// pair, so these tests exist to prove the emitted IL is verifiable (the
/// binding locals are declared inside an expression-position block) and that
/// the short-circuit is real at runtime.
open class Adr0151IfLetExpressionEmitTests {
    @Fact
    func IfLetExpression_InLetInit_ProducesValue() {
        let source = `package Test
import System

func Run(s string?) string {
    return if let v = s { v } else { "none" }
}

let a = Run("hi")
let b = Run(nil)
Console.WriteLine(a)
Console.WriteLine(b)`
        Assert.Equal("hi${Environment.NewLine}none${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetExpression_WithGuard() {
        let source = `package Test
import System

func Run(s string?) string {
    return if let v = s && v.Length > 3 { v } else { "short" }
}

Console.WriteLine(Run("hi"))
Console.WriteLine(Run("hello"))
Console.WriteLine(Run(nil))`
        Assert.Equal(
            "short${Environment.NewLine}hello${Environment.NewLine}short${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func IfLetExpression_AsCallArgument() {
        let source = `package Test
import System

func Get() string? {
    return "arg"
}

Console.WriteLine(if let v = Get() { v } else { "none" })`
        Assert.Equal("arg${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetExpression_InExpressionBodiedMember() {
        let source = `package Test
import System

class Holder {
    var items []?string

    prop First string? -> if let all = items && all.Length > 0 { all[0] } else { default(string?) }
}

let h = Holder()
h.items = []string{"first", "second"}
Console.WriteLine(h.First ?? "none")

let empty = Holder()
Console.WriteLine(empty.First ?? "none")`
        Assert.Equal("first${Environment.NewLine}none${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetExpression_EvaluatesInitializerExactlyOnce() {
        let source = `package Test
import System

var calls = 0
func Source() string? {
    calls = calls + 1
    return "x"
}

let v = if let s = Source() { s } else { "none" }
Console.WriteLine(v)
Console.WriteLine(calls)`
        Assert.Equal("x${Environment.NewLine}1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetExpression_ShortCircuits_LaterInitializerAndGuard() {
        let source = `package Test
import System

var secondCalls = 0
var guardCalls = 0

func First() string? {
    return nil
}

func Second() string? {
    secondCalls = secondCalls + 1
    return "b"
}

func Check() bool {
    guardCalls = guardCalls + 1
    return true
}

let v = if let a = First(), let b = Second() && Check() { b } else { "none" }
Console.WriteLine(v)
Console.WriteLine(secondCalls)
Console.WriteLine(guardCalls)`
        Assert.Equal("none${Environment.NewLine}0${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetExpression_MultipleBindings_LeftToRightAndVisibleToLaterInitializers() {
        let source = `package Test
import System

var log = ""

func A() string? {
    log = log + "a"
    return "A"
}

func B(seed string) string? {
    log = log + "b"
    return seed + "B"
}

let v = if let x = A(), let y = B(x) { y } else { "none" }
Console.WriteLine(v)
Console.WriteLine(log)`
        Assert.Equal("AB${Environment.NewLine}ab${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetExpression_NullableValueTypeBinding() {
        let source = `package Test
import System

func Run(n int32?) int32 {
    return if let v = n && v > 0 { v } else { -1 }
}

Console.WriteLine(Run(3))
Console.WriteLine(Run(-3))
Console.WriteLine(Run(nil))`
        Assert.Equal("3${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetExpression_ElseIfLetChain() {
        let source = `package Test
import System

func Run(a string?, b string?) string {
    return if let x = a { x } else if let y = b { y } else { "none" }
}

Console.WriteLine(Run("a", "b"))
Console.WriteLine(Run(nil, "b"))
Console.WriteLine(Run(nil, nil))`
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}none${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetExpression_NestedInsideIfExpressionBranch() {
        let source = `package Test
import System

func Run(flag bool, a string?) string {
    return if flag {
        if let x = a { x } else { "inner" }
    } else {
        "outer"
    }
}

Console.WriteLine(Run(true, "hit"))
Console.WriteLine(Run(true, nil))
Console.WriteLine(Run(false, "hit"))`
        Assert.Equal(
            "hit${Environment.NewLine}inner${Environment.NewLine}outer${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func IfLetExpression_BlockPrefixStatementsRunBeforeTheTail() {
        let source = `package Test
import System

func Run(s string?) int32 {
    return if let v = s {
        let n = v.Length
        n + 1
    } else {
        0
    }
}

Console.WriteLine(Run("abc"))
Console.WriteLine(Run(nil))`
        Assert.Equal("4${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetStatement_StillEmitsUnchanged() {
        // Regression guard: the ADR-0071 statement form is untouched.
        let source = `package Test
import System

func Run(s string?) int32 {
    if let v = s {
        return v.Length
    } else {
        return -1
    }
}

Console.WriteLine(Run("abcd"))
Console.WriteLine(Run(nil))`
        Assert.Equal("4${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func CompileAndRun_TimesOutOnHangingChildProcess() {
        // Issue #4987: reading stdout/stderr with synchronous ReadToEnd() before
        // WaitForExit(timeout) prevented the timeout from firing on a hung child.
        let source = `package Test
import System.Threading

Thread.Sleep(60_000)`
        let ex = Assert.ThrowsAny[Exception](
            func () object? {
                return CompileAndRun(source, timeoutMilliseconds: 200)
            }
        )
        Assert.Contains("dotnet exec timed out", ex.Message, StringComparison.Ordinal)
    }

    @Fact
    func CompileAndRun_TimesOutWhenDescendantKeepsStandardStreamsOpenAfterParentExits() {
        // Issue #4987 review: when the parent process exits immediately after
        // starting a descendant that inherits stdout/stderr, WaitForExit succeeds
        // while ReadToEndAsync remains open. Both stream reads must be bounded by
        // the same timeout deadline.
        let pidFile = Path.Combine(Path.GetTempPath(), "gs_adr0151_descendant_" + Guid.NewGuid().ToString("N") + ".pid")
        let escapedPidFile = pidFile.Replace("\\", "\\\\")
        let source = `package Test
import System
import System.Diagnostics
import System.IO
import System.Reflection
import System.Threading

if Environment.GetEnvironmentVariable("GS_ADR0151_DESCENDANT") == "1" {
    Thread.Sleep(10_000)
} else {
    let dllPath = Assembly.GetExecutingAssembly().Location
    let psi = ProcessStartInfo("dotnet"){
        UseShellExecute = false
    }
    psi.Environment["GS_ADR0151_DESCENDANT"] = "1"
    psi.ArgumentList.Add("exec")
    psi.ArgumentList.Add("--runtimeconfig")
    psi.ArgumentList.Add(Path.ChangeExtension(dllPath, ".runtimeconfig.json"))
    psi.ArgumentList.Add(dllPath)
    using let child = Process.Start(psi)
    if child != nil {
        File.WriteAllText("` + escapedPidFile + `", child.Id.ToString())
    }
}`
        try {
            let ex = Assert.ThrowsAny[Exception](
                func () object? {
                    return CompileAndRun(source, timeoutMilliseconds: 300)
                }
            )
            Assert.Contains("dotnet exec timed out", ex.Message, StringComparison.Ordinal)
        } finally {
            if File.Exists(pidFile) {
                if int32.TryParse(File.ReadAllText(pidFile).Trim(), out var childPid) {
                    try {
                        using let childProc = Process.GetProcessById(childPid)
                        childProc.Kill(entireProcessTree: true)
                    } catch { }
                }
                try {
                    File.Delete(pidFile)
                } catch { }
            }
        }
    }

    shared {
        internal func CompileAndRun(source string, timeoutMilliseconds int32 = 30_000) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_adr0151_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
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
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                // Issue #4987: read both streams concurrently and bound both process
                // exit and stream completion by the same deadline so a hung child or
                // a descendant inheriting stdout/stderr cannot block the test run.
                let stopwatch = Stopwatch.StartNew()
                let stdoutTask = proc.StandardOutput.ReadToEndAsync()
                let stderrTask = proc.StandardError.ReadToEndAsync()
                let exited = proc.WaitForExit(timeoutMilliseconds)
                let remainingMilliseconds = Math.Max(0, timeoutMilliseconds - int32(stopwatch.ElapsedMilliseconds))
                let streamsCompleted = exited && Task.WaitAll([]Task{stdoutTask, stderrTask}, remainingMilliseconds)
                if !streamsCompleted {
                    try {
                        proc.Kill(entireProcessTree: true)
                    } catch (InvalidOperationException) {
                        // The process exited between the timeout and the kill.

                    }
                    proc.StandardOutput.Close()
                    proc.StandardError.Close()
                    Assert.Fail("dotnet exec timed out")
                }
                let stdout = stdoutTask.GetAwaiter().GetResult()
                let stderr = stderrTask.GetAwaiter().GetResult()
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
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

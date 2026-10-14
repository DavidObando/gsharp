// <copyright file="Adr0065ConvenienceInitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// ADR-0065 §2 / §5: end-to-end emit tests for convenience initializers,
/// constructor self-delegation, and primary-ctor / explicit-init coexistence.
/// Each test compiles via `gsc`, runs `ilverify`, and then executes
/// the produced assembly under `dotnet exec` to assert behavior.
open class Adr0065ConvenienceInitEmitTests {
    @Fact
    func ConvenienceInit_DelegatesToDesignated_CompilesAndRuns() {
        let source = `package Probe
import System

class Rect {
    var Width int32
    var Height int32
    init(w int32, h int32) {
        Width = w
        Height = h
    }
    convenience init(side int32) {
        init(side, side)
    }
}

var r1 = Rect(3, 4)
var r2 = Rect(5)
Console.WriteLine(r1.Width)
Console.WriteLine(r1.Height)
Console.WriteLine(r2.Width)
Console.WriteLine(r2.Height)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "3${Environment.NewLine}4${Environment.NewLine}5${Environment.NewLine}5${Environment.NewLine}",
            output
        )
    }

    @Fact
    func ConvenienceInit_ChainOfConveniences_CompilesAndRuns() {
        // ADR-0065 §2: a convenience init may delegate to another convenience
        // init, which transitively reaches the designated initializer that
        // performs the actual field setup.
        let source = `package Probe
import System

class HttpClient {
    var BaseUrl string
    var Timeout int32
    init(baseUrl string, timeout int32) {
        BaseUrl = baseUrl
        Timeout = timeout
    }
    convenience init(baseUrl string) {
        init(baseUrl, 30)
    }
    convenience init() {
        init("http://localhost")
    }
}

var a = HttpClient("https://example", 5)
var b = HttpClient("https://other")
var c = HttpClient()
Console.WriteLine(a.BaseUrl)
Console.WriteLine(a.Timeout)
Console.WriteLine(b.BaseUrl)
Console.WriteLine(b.Timeout)
Console.WriteLine(c.BaseUrl)
Console.WriteLine(c.Timeout)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "https://example${Environment.NewLine}5${Environment.NewLine}https://other${Environment.NewLine}30${Environment.NewLine}http://localhost${Environment.NewLine}30${Environment.NewLine}",
            output
        )
    }

    @Fact
    func PrimaryCtorWithConvenience_DelegatesToSynthesizedPrimary() {
        // ADR-0065 §5: the synthesized primary-ctor init is one of the
        // designated initializers in the overload set. A convenience init may
        // delegate to it via `init(args)`.
        let source = `package Probe
import System

class LifecycleTab(Title string, Key string) {
    var Active bool = false
    convenience init(key string) {
        init(key, key)
    }
}

var t1 = LifecycleTab("Settings", "settings")
var t2 = LifecycleTab("home")
Console.WriteLine(t1.Title)
Console.WriteLine(t1.Key)
Console.WriteLine(t1.Active)
Console.WriteLine(t2.Title)
Console.WriteLine(t2.Key)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "Settings${Environment.NewLine}settings${Environment.NewLine}False${Environment.NewLine}home${Environment.NewLine}home${Environment.NewLine}",
            output
        )
    }

    @Fact
    func PrimaryCtorPlusInitOverload_BothInitializersWork() {
        // ADR-0065 §5: primary ctor `(Name string)` AND explicit
        // `init(age int32)` with distinct signatures both compile and are
        // selectable by argument type.
        let source = `package Probe
import System

class Person(Name string) {
    var Age int32
    init(age int32) {
        Age = age
    }
}

var byName = Person("Alice")
var byAge = Person(42)
Console.WriteLine(byName.Name)
Console.WriteLine(byAge.Age)`
        let output = CompileAndRun(source)
        Assert.Equal("Alice${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func DesignatedInit_UsingInitDelegation_ReportsError() {
        // ADR-0065 §2 / GS0281: only convenience init may use init(args)
        // self-delegation; designated must call base via : base() instead.
        let source = `package Probe

class Bad {
    var X int32
    init(x int32) {
        X = x
    }
    init() {
        init(0)
    }
}`
        let errors = CompileExpectingErrors(source)
        Assert.True(
            errors.Any((e string) -> e.Contains("GS0281") || e.Contains("designated")),
            "Expected GS0281: ${string.Join("\n", errors)}"
        )
    }

    @Fact
    func ConvenienceInit_WithoutDelegation_ReportsError() {
        // ADR-0065 §2 / GS0278: a convenience init body must begin with an
        // init(args) self-delegation.
        let source = `package Probe

class Bad {
    var X int32
    init(x int32) {
        X = x
    }
    convenience init() {
        X = 0
    }
}`
        let errors = CompileExpectingErrors(source)
        Assert.True(
            errors.Any((e string) -> e.Contains("GS0278") || e.Contains("delegate")),
            "Expected GS0278: ${string.Join("\n", errors)}"
        )
    }

    @Fact
    func ConvenienceInit_WithBaseClause_ReportsError() {
        // ADR-0065 §2 / GS0279: convenience init may not declare ': base()'.
        let source = `package Probe

open class Animal {
    var Name string
    init(name string) {
        Name = name
    }
}

class Dog : Animal {
    init(name string) : base(name) {
    }
    convenience init() : base("rex") {
        init("rex")
    }
}`
        let errors = CompileExpectingErrors(source)
        Assert.True(
            errors.Any((e string) -> e.Contains("GS0279") || e.Contains("convenience")),
            "Expected GS0279: ${string.Join("\n", errors)}"
        )
    }

    @Fact
    func InitDelegation_OutsideCtor_ReportsError() {
        // ADR-0065 §2 / GS0280: bare init(args) outside any ctor body is not
        // a valid identifier-call. Falls through to the standard "unknown
        // function" diagnostic since `init` only has special meaning inside
        // a class ctor body.
        let source = `package Probe

class Foo {
    init() {
    }
}

func main() {
    init(1)
}`
        let errors = CompileExpectingErrors(source)
        // The bare identifier `init` outside a ctor body has no binding;
        // either GS0280 (if we ever surface it from a free-function ctx)
        // or a generic "undefined name" diagnostic is acceptable.
        Assert.NotEmpty(errors)
    }

    @Fact
    func ConvenienceInit_OverloadResolution_PicksMatchingSibling() {
        // ADR-0065 §2 + ADR-0063 §9: when multiple sibling overloads exist
        // the init(args) call uses arity/type-based overload resolution.
        let source = `package Probe
import System

class Color {
    var R int32
    var G int32
    var B int32
    init(r int32, g int32, b int32) {
        R = r
        G = g
        B = b
    }
    init(gray int32) {
        R = gray
        G = gray
        B = gray
    }
    convenience init() {
        init(0)
    }
}

var black = Color()
var gray = Color(128)
var red = Color(255, 0, 0)
Console.WriteLine(black.R)
Console.WriteLine(gray.G)
Console.WriteLine(red.R)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}128${Environment.NewLine}255${Environment.NewLine}", output)
    }

    shared {
        // ====================================================================
        // Helpers
        // ====================================================================
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_adr0065_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
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
                } catch {
                    // ignored

                }
            }
        }

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_adr0065_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}

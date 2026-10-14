// <copyright file="Issue711IfExpressionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #711 / ADR-0064 — end-to-end emit coverage that finalises the
/// if-expression. Each test compiles via in-process `gsc`, IL-verifies
/// the emitted PE, then executes the assembly under `dotnet exec` and
/// asserts captured stdout. Mirrors the scenarios called out in the issue's
/// acceptance criteria: value flowing through let-init, call argument,
/// return, nested forms, reference-vs-value branch tail unification, and
/// throw in the prefix of one branch.
open class Issue711IfExpressionEmitTests {
    @Fact
    func IfExpression_InLetInit_ProducesValue() {
        let source = `package Test
import System

let label = if 5 > 0 { "positive" } else if 5 < 0 { "negative" } else { "zero" }
Console.WriteLine(label)`
        Assert.Equal("positive${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_AsCallArgument() {
        let source = `package Test
import System

let n = 0
Console.WriteLine(if n == 0 { "z" } else { "nz" })`
        Assert.Equal("z${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_InReturnStatement() {
        let source = `package Test
import System

func Sign(n int32) string {
    return if n > 0 { "+" } else if n < 0 { "-" } else { "0" }
}
Console.WriteLine(Sign(3))
Console.WriteLine(Sign(-3))
Console.WriteLine(Sign(0))`
        Assert.Equal("+${Environment.NewLine}-${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_Nested_TwoLevels() {
        let source = `package Test
import System

let a = true
let b = false
let n = if a { if b { 1 } else { 2 } } else { 3 }
Console.WriteLine(n)`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_NumericWidening_PicksWiderType() {
        let source = `package Test
import System

let a int32 = 1
let b int64 = 2
let x = if true { a } else { b }
Console.WriteLine(x)`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_NilArm_UnifiesAsNullableReference() {
        let source = `package Test
import System

let s string? = "hi"
let r = if true { s } else { nil }
if let v = r {
    Console.WriteLine(v)
} else {
    Console.WriteLine("nil")
}`
        Assert.Equal("hi${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_ThrowInPrefix_RunsOnlyChosenArm() {
        // The throw in the then-arm only fires when the condition is true.
        // With a false condition the else-arm produces 42 and execution
        // continues normally.
        let source = `package Test
import System

func Run(b bool) int32 {
    let x = if b {
        throw Exception(message: "bad")
        0
    } else {
        42
    }
    return x
}
Console.WriteLine(Run(false))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_MultiStatementBlock_RunsPrefixThenLiftsTrailing() {
        let source = `package Test
import System

var sink = ""
let title = if true {
    sink = "side-effect"
    "Admin"
} else {
    "Home"
}
Console.WriteLine(title)
Console.WriteLine(sink)`
        Assert.Equal("Admin${Environment.NewLine}side-effect${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_ElseIfChain_FourArms() {
        let source = `package Test
import System

func Grade(p int32) string {
    return if p >= 90 { "A" } else if p >= 80 { "B" } else if p >= 70 { "C" } else { "F" }
}
Console.WriteLine(Grade(95))
Console.WriteLine(Grade(85))
Console.WriteLine(Grade(75))
Console.WriteLine(Grade(50))`
        Assert.Equal(
            "A${Environment.NewLine}B${Environment.NewLine}C${Environment.NewLine}F${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func IfExpression_OnlyChosenArmIsEvaluated_NoSideEffectOnLosingArm() {
        // Side-effect guard: divide-by-zero in the unchosen arm must not
        // execute. This pins down the "lazy" semantics of the if-expression
        // (only one arm is bound and emitted to run).
        let source = `package Test
import System

let denom = 0
let pick = true
let v = if pick { 100 } else { 1 / denom }
Console.WriteLine(v)`
        Assert.Equal("100${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfExpression_ValueAndObject_UnifiesViaBoxing() {
        // Cross-kind branch types unify via the common-type rule when one
        // branch is implicitly convertible to the other. Here both arms
        // satisfy the implicit conversion to `object`.
        let source = `package Test
import System

func Pick(b bool) object {
    return if b { 42 } else { "hi" as object }
}
Console.WriteLine(Pick(true))
Console.WriteLine(Pick(false))`
        Assert.Equal("42${Environment.NewLine}hi${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfStatement_StillWorks_Unchanged() {
        // Regression guard: existing `if` statements continue to parse and
        // execute exactly as before — ADR-0064 must NOT break the statement
        // form.
        let source = `package Test
import System

var x = 0
if true {
    x = 42
}
Console.WriteLine(x)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue711_").FullName
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
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
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

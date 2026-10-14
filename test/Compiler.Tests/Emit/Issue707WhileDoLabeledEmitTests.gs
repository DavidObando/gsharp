// <copyright file="Issue707WhileDoLabeledEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #707 / ADR-0070: end-to-end emit tests for the new `while`,
/// `do`-`while`, and labeled `break`/`continue`
/// statement forms. Verifies that the binder lowers each form to a
/// valid IL goto/label sequence and that running the produced assembly
/// produces the expected console output.
open class Issue707WhileDoLabeledEmitTests {
    @Fact
    func While_PrintsIterations() {
        let source = `package P
import System

var i = 0
while i < 3 {
    Console.WriteLine(i)
    i = i + 1
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func DoWhile_RunsBodyAtLeastOnce_EvenWhenConditionFalse() {
        let source = `package P
import System

var i = 5
do {
    Console.WriteLine(i)
    i = i + 1
} while i < 5`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func DoWhile_RunsBodyMultipleTimes_WhenConditionTrue() {
        let source = `package P
import System

var i = 0
do {
    Console.WriteLine(i)
    i = i + 1
} while i < 3`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func LabeledBreak_FromNestedFor_ExitsBothLoops() {
        let source = `package P
import System

outer: for var i = 0; i < 3; i++ {
    for var j = 0; j < 3; j++ {
        if i == 1 && j == 1 {
            Console.WriteLine("breaking")
            break outer
        }
        Console.WriteLine("$i,$j")
    }
}
Console.WriteLine("done")`
        let output = CompileAndRun(source)
        Assert.Equal(
            "0,0${Environment.NewLine}0,1${Environment.NewLine}0,2${Environment.NewLine}1,0${Environment.NewLine}breaking${Environment.NewLine}done${Environment.NewLine}",
            output
        )
    }

    @Fact
    func LabeledContinue_SkipsToOuterPost() {
        let source = `package P
import System

outer: for var i = 0; i < 3; i++ {
    for var j = 0; j < 3; j++ {
        if j == 1 {
            continue outer
        }
        Console.WriteLine("$i,$j")
    }
}`
        let output = CompileAndRun(source)
        // Each i iteration prints only j=0 before continuing the outer loop.
        Assert.Equal("0,0${Environment.NewLine}1,0${Environment.NewLine}2,0${Environment.NewLine}", output)
    }

    @Fact
    func LabeledWhile_BreakFromInnerFor_ExitsLabeledWhile() {
        let source = `package P
import System

var n = 0
outer: while n < 100 {
    for var j = 0; j < 5; j++ {
        if j == 2 {
            break outer
        }
        Console.WriteLine("$n-$j")
    }
    n = n + 1
}`
        let output = CompileAndRun(source)
        Assert.Equal("0-0${Environment.NewLine}0-1${Environment.NewLine}", output)
    }

    @Fact
    func LabeledDoWhile_BreakFromInnerFor_ExitsLabeledDoWhile() {
        let source = `package P
import System

spin: do {
    for var j = 0; j < 5; j++ {
        if j == 3 {
            break spin
        }
        Console.WriteLine(j)
    }
} while true
Console.WriteLine("after")`
        let output = CompileAndRun(source)
        Assert.Equal(
            "0${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}after${Environment.NewLine}",
            output
        )
    }

    @Fact
    func UnlabeledBreakInLabeledOuter_OnlyExitsInnermost() {
        let source = `package P
import System

outer: for var i = 0; i < 2; i++ {
    for var j = 0; j < 5; j++ {
        if j == 2 {
            break
        }
        Console.WriteLine("$i-$j")
    }
}`
        let output = CompileAndRun(source)
        // For each i: j=0,1 before inner break. 2 i's.
        Assert.Equal(
            "0-0${Environment.NewLine}0-1${Environment.NewLine}1-0${Environment.NewLine}1-1${Environment.NewLine}",
            output
        )
    }

    @Fact
    func TripleNested_LabeledBreak_TargetsOutermost() {
        let source = `package P
import System

a: for var i = 0; i < 3; i++ {
    b: for var j = 0; j < 3; j++ {
        for var k = 0; k < 3; k++ {
            if i == 0 && j == 1 && k == 2 {
                break a
            }
            Console.WriteLine("$i$j$k")
        }
    }
}
Console.WriteLine("end")`
        let output = CompileAndRun(source)
        // Iterations: 000,001,002, 010,011 — then break a → end.
        Assert.Equal(
            "000${Environment.NewLine}001${Environment.NewLine}002${Environment.NewLine}010${Environment.NewLine}011${Environment.NewLine}end${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue707_").FullName
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

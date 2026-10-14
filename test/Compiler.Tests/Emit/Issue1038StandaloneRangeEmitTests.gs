// <copyright file="Issue1038StandaloneRangeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1038: emit/execution coverage for the standalone range value
/// (`let r = 1..3`) and its use as an index argument (`a[r]`). These
/// tests compile and run emitted programs (with ilverify) and assert the printed
/// results across arrays, `[]T` slices, strings, and span-like values, plus
/// the from-end upper bound and the four open forms.
open class Issue1038StandaloneRangeEmitTests {
    @Fact
    func RangeValue_SlicesArray_ClosedRange() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let r = 1..3
let b = a[r]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_SlicesArray_OpenLowerBound() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let r = ..2
let b = a[r]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}10${Environment.NewLine}20${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_SlicesArray_OpenUpperBound() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let r = 3..
let b = a[r]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}40${Environment.NewLine}50${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_SlicesArray_FullRange() {
        let source = `package P
import System

let a = []int32{1, 2, 3, 4}
let r = ..
let b = a[r]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[3])`
        Assert.Equal("4${Environment.NewLine}1${Environment.NewLine}4${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_FromEndUpperBound_SlicesArray() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let r = 1..^1
let b = a[r]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[2])`
        Assert.Equal("3${Environment.NewLine}20${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_OpenLowerWithFromEndUpper_SlicesArray() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let r = ..^2
let b = a[r]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[2])`
        Assert.Equal("3${Environment.NewLine}10${Environment.NewLine}30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_SlicesString() {
        let source = `package P
import System

let s = "hello world"
let r = 6..
Console.WriteLine(s[r])`
        Assert.Equal("world${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_AdditivePrecedence() {
        // 1+1..2+2 == 2..4 -> {30, 40}.
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let r = 1+1..2+2
let b = a[r]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}30${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_InlineParenthesized() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[(1..3)]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])`
        Assert.Equal("2${Environment.NewLine}20${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RangeValue_SlicesSpanLike_ArraySegment() {
        // ArraySegment<int> exposes Count + Slice(int, int): the span-like path.
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let seg = ArraySegment[int32](a)
let r = 1..4
let s = seg[r]
Console.WriteLine(s.Count)
Console.WriteLine(s[0])
Console.WriteLine(s[2])`
        Assert.Equal("3${Environment.NewLine}20${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LeadingFromEndMarker_BuildsReusableRange_Adr0187() {
        let source = `package P
import System

let r = ^1..3
Console.WriteLine(r.Start.IsFromEnd)
Console.WriteLine(r.Start.Value)
Console.WriteLine(r.End.IsFromEnd)
Console.WriteLine(r.End.Value)`
        let nl = Environment.NewLine
        Assert.Equal("True${nl}1${nl}False${nl}3$nl", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1038_emit_").FullName
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

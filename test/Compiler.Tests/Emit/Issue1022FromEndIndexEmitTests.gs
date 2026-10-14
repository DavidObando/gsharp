// <copyright file="Issue1022FromEndIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1022: the from-end index marker `^n` indexes/slices from the end
/// of an array, slice, string, or span-like value. These tests compile and run
/// emitted programs and assert the printed results, covering:
/// - a bare `a[^n]` single-element read (`length - n`).
/// - from-end bounds in ranges (`a[1..^1]`, `a[..^3]`, `a[^2..]`).
/// - arrays/slices, strings, and span-like (`ArraySegment`) targets.
/// - regression: one's-complement (`~`) and XOR `^` are unchanged.
open class Issue1022FromEndIndexEmitTests {
    @Fact
    func IntArray_SingleFromEndIndex() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
Console.WriteLine(a[^1])
Console.WriteLine(a[^2])
Console.WriteLine(a[^5])`
        Assert.Equal("50${Environment.NewLine}40${Environment.NewLine}10${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IntArray_FromEndUpperBound_DropsLast() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[1..^1]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[2])`
        Assert.Equal("3${Environment.NewLine}20${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IntArray_FromEndUpperBound_OpenLower() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[..^3]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}10${Environment.NewLine}20${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IntArray_FromEndLowerBound_OpenUpper() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[^2..]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}40${Environment.NewLine}50${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IntArray_FromEndBothBounds() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[^4..^1]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[2])`
        Assert.Equal("3${Environment.NewLine}20${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func String_FromEndForms() {
        let source = `package P
import System

let s = "abcdef"
Console.WriteLine(s[..^3])
Console.WriteLine(s[1..^1])
Console.WriteLine(s[^2..])`
        Assert.Equal(
            "abc${Environment.NewLine}bcde${Environment.NewLine}ef${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ArraySegment_SpanLikeFromEndSlice() {
        // ArraySegment[T] has `int Count`; from-end bounds compute against it.
        let source = `package P
import System

let arr = []int32{10, 20, 30, 40, 50}
let seg = ArraySegment[int32](arr)
let sub = seg[1..^1]
Console.WriteLine(sub.Count)
Console.WriteLine(sub[0])
Console.WriteLine(sub[2])`
        Assert.Equal("3${Environment.NewLine}20${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IReadOnlyList_InheritedCountSupportsFromEndIndex() {
        let source = `package P
import System
import System.Collections.Generic

let values IReadOnlyList[int32] = List[int32]{10, 20, 30}
Console.WriteLine(values[^1])
Console.WriteLine(values[^3])`
        Assert.Equal("30${Environment.NewLine}10${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OnesComplementAndXor_Unchanged() {
        // Regression: one's-complement (spelled `~` since ADR-0187) and infix
        // `^` (XOR) keep their meanings.
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
Console.WriteLine(~0)
Console.WriteLine(6 ^ 3)
Console.WriteLine(a[1 ^ 2])`
        Assert.Equal("-1${Environment.NewLine}5${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1022_emit_").FullName
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

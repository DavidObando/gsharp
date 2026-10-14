// <copyright file="Issue1016RangeSliceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1016: the range/slice operator `..` slices arrays, slices,
/// strings, and span-like values inside an indexer (`a[lo..hi]`, with the
/// open forms `a[..hi]`, `a[lo..]`, `a[..]`). These tests
/// compile and run emitted programs and assert the printed results, exercising
/// the BCL mappings:
/// - arrays/slices -> `new T[len]` + `Array.Copy`.
/// - `string` -> `Substring(start, len)`.
/// - span-like types with `Count` + `Slice(int, int)` (e.g. `ArraySegment`).
open class Issue1016RangeSliceEmitTests {
    @Fact
    func IntArray_ClosedRange() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[1..3]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IntArray_OpenLowerBound() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[..2]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}10${Environment.NewLine}20${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IntArray_OpenUpperBound() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[3..]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[1])`
        Assert.Equal("2${Environment.NewLine}40${Environment.NewLine}50${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IntArray_FullRange_CopiesAll() {
        let source = `package P
import System

let a = []int32{10, 20, 30, 40, 50}
let b = a[..]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[4])`
        Assert.Equal("5${Environment.NewLine}10${Environment.NewLine}50${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IntArray_Slice_IsACopy_NotAnAlias() {
        // Mutating the original array after slicing must not change the slice,
        // proving GetSubArray semantics (a fresh backing array).
        let source = `package P
import System

var a = []int32{1, 2, 3, 4}
let b = a[0..2]
a[0] = 99
Console.WriteLine(b[0])`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func String_ClosedRange() {
        let source = `package P
import System

let s = "hello world"
Console.WriteLine(s[0..5])`
        Assert.Equal("hello${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func String_OpenBounds() {
        let source = `package P
import System

let s = "hello world"
Console.WriteLine(s[6..])
Console.WriteLine(s[..5])
Console.WriteLine(s[..])`
        Assert.Equal(
            "world${Environment.NewLine}hello${Environment.NewLine}hello world${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func UserStructArray_SlicePreservesElements() {
        // Slicing an array of a user-defined struct exercises the `newarr`
        // element-type token path for a same-compilation TypeDef.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
}

let pts = []Point{Point{X: 1, Y: 2}, Point{X: 3, Y: 4}, Point{X: 5, Y: 6}}
let sl = pts[1..3]
Console.WriteLine(sl[0].X)
Console.WriteLine(sl[1].X)`
        Assert.Equal("3${Environment.NewLine}5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ArraySegment_SpanLikeSlicePath() {
        // ArraySegment[T] has `int Count` + `Slice(int, int)`, exercising the
        // span-like slicing path (no Array.Copy).
        let source = `package P
import System

let arr = []int32{10, 20, 30, 40, 50}
let seg = ArraySegment[int32](arr)
let sub = seg[1..4]
Console.WriteLine(sub.Count)
Console.WriteLine(sub[0])
Console.WriteLine(sub[2])`
        Assert.Equal("3${Environment.NewLine}20${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Slice_ComputedBoundsFromExpressions() {
        // Bounds are arbitrary int expressions, not just literals.
        let source = `package P
import System

let a = []int32{0, 1, 2, 3, 4, 5, 6, 7}
let lo = 2
let hi = 6
let b = a[lo..hi]
Console.WriteLine(b.Length)
Console.WriteLine(b[0])
Console.WriteLine(b[3])`
        Assert.Equal("4${Environment.NewLine}2${Environment.NewLine}5${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1016_emit_").FullName
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

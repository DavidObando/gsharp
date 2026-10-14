// <copyright file="Issue4350IndexRangeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// ADR-0187 / issue #4350: prefix `^x` is a first-class
/// `System.Index` expression, standalone ranges accept from-end and saved
/// Index bounds, and unary one's-complement is spelled `~x`. Each program
/// is compiled, IL-verified, and executed.
open class Issue4350IndexRangeEmitTests {
    @Fact
    func SavedIndex_IndexesArraysStringsListsAndSpans() {
        let source = `package P
import System
import System.Collections.Generic

let xs = []int32{10, 20, 30, 40, 50}
let last = ^1
let third System.Index = ^3
Console.WriteLine(xs[last])
Console.WriteLine(xs[third])
Console.WriteLine(third.IsFromEnd)
Console.WriteLine(third.Value)
Console.WriteLine(third.GetOffset(xs.Length))
Console.WriteLine("gsharp"[last])
let list = List[int32](xs)
Console.WriteLine(list[third])
func spanLast(values []int32, index System.Index) int32 {
    let span = Span[int32](values)
    return span[index]
}
Console.WriteLine(spanLast(xs, last))`
        Assert.Equal(Lines("50", "30", "True", "3", "2", "p", "30", "50"), CompileAndRun(source))
    }

    @Fact
    func Index_FlowsThroughParametersReturnsFieldsGenericsAndNullable() {
        let source = `package P
import System
import System.Collections.Generic

func pick(xs []int32, i System.Index) int32 -> xs[i]

func fromEnd(n int32) System.Index -> ^n

class Holder {
    var At System.Index = ^2
}

let xs = []int32{10, 20, 30, 40, 50}
Console.WriteLine(pick(xs, ^1))
Console.WriteLine(pick(xs, fromEnd(4)))
let holder = Holder()
Console.WriteLine(xs[holder.At])
holder.At = ^5
Console.WriteLine(xs[holder.At])
let ids = List[System.Index]()
ids.Add(^1)
ids.Add(^3)
Console.WriteLine(xs[ids[1]])
var maybe System.Index? = nil
Console.WriteLine(maybe == nil)
maybe = ^4
Console.WriteLine(xs[maybe!!])
let boxed object = ^2
Console.WriteLine(boxed)`
        Assert.Equal(Lines("50", "20", "40", "10", "30", "True", "20", "^2"), CompileAndRun(source))
    }

    @Fact
    func StandaloneRanges_AcceptFromEndAndSavedIndexBounds() {
        let source = `package P
import System

let xs = []int32{10, 20, 30, 40, 50}
func show(values []int32) {
    Console.WriteLine(String.Join(",", values))
}

let trimmed = ^4..^1
show(xs[trimmed])
let tail = ^3..
show(xs[tail])
let head = ..^2
show(xs[head])
let all = ..
show(xs[all])
let i = ^4
let j System.Index = 4
let saved = i..j
show(xs[saved])
show(xs[i..])
show(xs[(^2)..])
Console.WriteLine("abcdef"[^4..^1])
Console.WriteLine(trimmed)`
        Assert.Equal(
            Lines(
                "20,30,40",
                "30,40,50",
                "10,20,30",
                "10,20,30,40,50",
                "20,30,40",
                "20,30,40,50",
                "40,50",
                "cde",
                "^4..^1"
            ),
            CompileAndRun(source)
        )
    }

    @Fact
    func NativeSlice_AcceptsSavedIndexAndLeadingFromEndRange() {
        let source = `package P
import System

let values = slice[int32]{10, 20, 30, 40, 50}
let last = ^1
Console.WriteLine(values[last])
let middle = values[^4..^1]
Console.WriteLine(middle.Length)
Console.WriteLine(middle[0])
let i = ^2
let tail = values[i..]
Console.WriteLine(tail.Length)
Console.WriteLine(tail[0])`
        Assert.Equal(Lines("50", "3", "20", "2", "40"), CompileAndRun(source))
    }

    @Fact
    func IndexAndRangeBounds_EvaluateOnceLeftToRight() {
        let source = `package P
import System
import System.Collections.Generic

func tick(log List[string], name string, value int32) int32 {
    log.Add(name)
    return value
}

let log = List[string]()
let xs = []int32{10, 20, 30, 40, 50}
let r = ^tick(log, "a", 3)..^tick(log, "b", 1)
Console.WriteLine(String.Join(",", log))
Console.WriteLine(String.Join(",", xs[r]))
log.Clear()
let i = ^tick(log, "c", 2)
Console.WriteLine(xs[i] + xs[i])
Console.WriteLine(String.Join(",", log))
log.Clear()
let s = xs[^tick(log, "d", 4)..tick(log, "e", 3)]
Console.WriteLine(String.Join(",", s))
Console.WriteLine(String.Join(",", log))`
        Assert.Equal(Lines("a,b", "30,40", "80", "c", "20,30", "d,e"), CompileAndRun(source))
    }

    @Fact
    func FromEndIndex_PreservesClrExceptionBehavior() {
        let source = `package P
import System

let xs = []int32{10, 20, 30}
let zero = ^0
Console.WriteLine(zero.GetOffset(xs.Length))
try {
    Console.WriteLine(xs[zero])
} catch (e IndexOutOfRangeException) {
    Console.WriteLine("index")
}

var n = -1
try {
    let bad = ^n
    Console.WriteLine(bad)
} catch (e ArgumentOutOfRangeException) {
    Console.WriteLine("argument")
}`
        Assert.Equal(Lines("3", "index", "argument"), CompileAndRun(source))
    }

    @Fact
    func Tilde_IsOnesComplement_AndBinaryHatStaysXor() {
        let source = `package P
import System
import System.IO

struct Bits(Value int32) {
}

func (a Bits) operator ~() Bits -> Bits{Value: ~a.Value}

enum Mask { None = 0, All = ~0 }

const Complement = ~15u
let five = 5
Console.WriteLine(~five)
Console.WriteLine(~0u)
Console.WriteLine(Complement)
Console.WriteLine(int32(~FileShare.None))
Console.WriteLine(int32(Mask.All))
Console.WriteLine((~Bits{Value: 6}).Value)
Console.WriteLine(6 ^ 3)
var x = 6
x ^= 3
Console.WriteLine(x)
let xs = []int32{10, 20, 30, 40, 50}
Console.WriteLine(xs[~-3])
Console.WriteLine(xs[1 ^ 2])`
        Assert.Equal(
            Lines("-6", "4294967295", "4294967280", "-1", "-1", "-7", "5", "5", "30", "40"),
            CompileAndRun(source)
        )
    }

    shared {
        private func Lines(lines ...string) string -> string.Concat(
            Array.ConvertAll(lines, (line string) -> (line + Environment.NewLine))
        )

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4350_emit_").FullName
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
                using let proc = Process.Start(psi)!!
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

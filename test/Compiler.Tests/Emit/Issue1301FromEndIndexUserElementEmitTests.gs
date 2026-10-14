// <copyright file="Issue1301FromEndIndexUserElementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1301: a from-end index `list[^n]` (a `System.Index` /
/// counted `this[int]` read) over a generic collection whose element type
/// `T` is a same-compilation user type erased the result element to
/// `object` (GS0155 / GS0158), even though the normal `this[int]`
/// path substituted `T` correctly. These tests pin the fix end-to-end by
/// running the emitted IL and asserting the runtime value read from the
/// user-element member — proving both that the element type is recovered AND
/// that the IL emits correctly. A `List[int32]` control guards the
/// primitive path against regressions.
open class Issue1301FromEndIndexUserElementEmitTests {
    @Fact
    func StructElementList_FromEndIndex_ReadsMember() {
        let source = `package P
import System
import System.Collections.Generic

struct Chapter { prop EndOffset int32 { get; init; } }

var l = List[Chapter]()
l.Add(Chapter{EndOffset: 10})
l.Add(Chapter{EndOffset: 20})
l.Add(Chapter{EndOffset: 30})
Console.WriteLine(l[^1].EndOffset)
Console.WriteLine(l[^2].EndOffset)
Console.WriteLine(l[^3].EndOffset)`
        Assert.Equal("30${Environment.NewLine}20${Environment.NewLine}10${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructElementList_FromEndIndex_WholeElementType() {
        // The from-end read returns `Chapter` (not `object`), so it can be
        // assigned to a `Chapter`-typed local and have its member read.
        let source = `package P
import System
import System.Collections.Generic

struct Chapter { prop EndOffset int32 { get; init; } }

var l = List[Chapter]()
l.Add(Chapter{EndOffset: 7})
l.Add(Chapter{EndOffset: 9})
var last = l[^1]
Console.WriteLine(last.EndOffset)`
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DataStructElementList_FromEndIndex_ReadsMember() {
        let source = `package P
import System
import System.Collections.Generic

data struct Point { var X int32
                    var Y int32 }

var l = List[Point]()
l.Add(Point{X: 1, Y: 2})
l.Add(Point{X: 3, Y: 4})
l.Add(Point{X: 5, Y: 6})
Console.WriteLine(l[^1].Y)
Console.WriteLine(l[^2].X)`
        Assert.Equal("6${Environment.NewLine}3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ClassElementList_FromEndIndex_ReadsMember() {
        let source = `package P
import System
import System.Collections.Generic

class Seg { public var X int32 = 0 }

var a = Seg()
a.X = 11
var b = Seg()
b.X = 22
var l = List[Seg]()
l.Add(a)
l.Add(b)
Console.WriteLine(l[^1].X)
Console.WriteLine(l[^2].X)`
        Assert.Equal("22${Environment.NewLine}11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PrimitiveElementList_FromEndIndex_StillWorks() {
        // Regression control: the primitive (List[int32]) path is unchanged.
        let source = `package P
import System
import System.Collections.Generic

var l = List[int32]()
l.Add(10)
l.Add(20)
l.Add(30)
Console.WriteLine(l[^1])
Console.WriteLine(l[^2])
Console.WriteLine(l[^3])`
        Assert.Equal("30${Environment.NewLine}20${Environment.NewLine}10${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IReadOnlyListTypeParameter_FromEndIndex_InfersElementTypeAndUsesInheritedCount() {
        // `items[^n]` on an imported generic interface receiver uses BOTH the
        // inherited `Count` candidate (`IReadOnlyCollection[T]`) and the
        // `this[int]` candidate (`IReadOnlyList[T]`). Keep `T` inferred from the
        // G# argument so the result element must round-trip as the user type,
        // not `object`.
        let source = `package P
import System
import System.Collections.Generic

class ChapterRef { prop EndOffset int32 { get; init; } }

func Tail[T any](items IReadOnlyList[T]) T {
    return items[^1]
}

func BeforeTail[T any](items IReadOnlyList[T]) T {
    return items[^2]
}

var chapters = List[ChapterRef]()
chapters.Add(ChapterRef{EndOffset: 4})
chapters.Add(ChapterRef{EndOffset: 9})
chapters.Add(ChapterRef{EndOffset: 15})

let items IReadOnlyList[ChapterRef] = chapters
Console.WriteLine(BeforeTail(items).EndOffset)
Console.WriteLine(Tail(items).EndOffset)`
        Assert.Equal("9${Environment.NewLine}15${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1301_").FullName
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
                } catch { }
            }
        }
    }
}

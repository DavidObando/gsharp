// <copyright file="SlicePatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1505: slice ("rest") subpatterns in list patterns. These tests
/// exercise the emitter end-to-end (compile → ilverify → run) for every
/// supported slice form and assert runtime behavior + captured slice contents.
/// Each test uses unique package/type/func names because the FunctionTypeSymbol
/// cache is not cleared between in-process tests.
open class SlicePatternEmitTests {
    @Fact
    func SlicePattern_Bookend_MatchesRegardlessOfMiddleLength() {
        let gsource = `package Slice.Bookend
import System

func classify(xs []int32) {
    switch xs {
        case [1, .., 3] { Console.WriteLine("bookend") }
        default { Console.WriteLine("other") }
    }
}

classify([]int32{1, 3})
classify([]int32{1, 2, 3})
classify([]int32{1, 9, 9, 9, 3})
classify([]int32{2, 3})
classify([]int32{1, 2})`
        let output = CompileAndRun(gsource)
        Assert.Equal(
            "bookend${Environment.NewLine}bookend${Environment.NewLine}bookend${Environment.NewLine}other${Environment.NewLine}other${Environment.NewLine}",
            output
        )
    }

    @Fact
    func SlicePattern_TooShort_DoesNotMatch() {
        let gsource = `package Slice.TooShort
import System

func classify(xs []int32) {
    switch xs {
        case [1, .., 3] { Console.WriteLine("bookend") }
        default { Console.WriteLine("other") }
    }
}

classify([]int32{5})
classify([]int32{})`
        let output = CompileAndRun(gsource)
        Assert.Equal("other${Environment.NewLine}other${Environment.NewLine}", output)
    }

    @Fact
    func SlicePattern_SuffixOnly_BindsLastElement() {
        let gsource = `package Slice.SuffixOnly
import System

func ends(xs []int32) {
    switch xs {
        case [.., l is int32] { Console.WriteLine("last=${l}") }
        default { Console.WriteLine("empty") }
    }
}

ends([]int32{100, 200})
ends([]int32{7})
ends([]int32{})`
        let output = CompileAndRun(gsource)
        Assert.Equal("last=200${Environment.NewLine}last=7${Environment.NewLine}empty${Environment.NewLine}", output)
    }

    @Fact
    func SlicePattern_PrefixOnly_BindsFirstElement() {
        let gsource = `package Slice.PrefixOnly
import System

func heads(xs []int32) {
    switch xs {
        case [f is int32, ..] { Console.WriteLine("first=${f}") }
        default { Console.WriteLine("empty") }
    }
}

heads([]int32{42, 1, 2})
heads([]int32{9})
heads([]int32{})`
        let output = CompileAndRun(gsource)
        Assert.Equal("first=42${Environment.NewLine}first=9${Environment.NewLine}empty${Environment.NewLine}", output)
    }

    @Fact
    func SlicePattern_DiscardSlice_MatchesAnyLength() {
        let gsource = `package Slice.AnyLength
import System

func any(xs []int32) {
    switch xs {
        case [..] { Console.WriteLine("any") }
        default { Console.WriteLine("never") }
    }
}

any([]int32{})
any([]int32{1})
any([]int32{1, 2, 3})`
        let output = CompileAndRun(gsource)
        Assert.Equal("any${Environment.NewLine}any${Environment.NewLine}any${Environment.NewLine}", output)
    }

    @Fact
    func SlicePattern_CapturedRest_MaterializesMiddleSlice() {
        let gsource = `package Slice.Captured
import System

func describe(xs []int32) {
    switch xs {
        case [f is int32, ..rest, l is int32] {
            Console.WriteLine("first=${f} last=${l} restLen=${rest.Length}")
        }
        default { Console.WriteLine("nomatch") }
    }
}

describe([]int32{10, 20, 30, 40})
describe([]int32{7, 8})
describe([]int32{5})`
        let output = CompileAndRun(gsource)
        Assert.Equal(
            "first=10 last=40 restLen=2${Environment.NewLine}first=7 last=8 restLen=0${Environment.NewLine}nomatch${Environment.NewLine}",
            output
        )
    }

    @Fact
    func SlicePattern_CapturedRest_MiddleContentsAreCorrect() {
        let gsource = `package Slice.CapturedHead
import System

func mid(xs []int32) {
    switch xs {
        case [_, ..rest, _] { Console.WriteLine("${rest[0]} ${rest[1]}") }
        default { Console.WriteLine("nomatch") }
    }
}

mid([]int32{10, 20, 30, 40})`
        let output = CompileAndRun(gsource)
        Assert.Equal("20 30${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1505_").FullName
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
                } catch { }
            }
        }
    }
}

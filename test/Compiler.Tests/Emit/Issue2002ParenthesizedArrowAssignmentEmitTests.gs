// <copyright file="Issue2002ParenthesizedArrowAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2002 / ADR-0122 §4: end-to-end emit + execution tests for
/// assignment through an EXPLICITLY PARENTHESIZED pointer-arrow receiver —
/// `(expr)->Member = value`. Before the fix, the parser's `(...) ->`
/// lambda-vs-pointer-arrow disambiguator (`LooksLikeLambdaStart`)
/// mis-parsed this shape as a lambda expression (silently, for a bare
/// identifier receiver) or reported a spurious GS0005 (for any other
/// receiver, e.g. a dereference), depending on the exact interior shape.
/// Covers the motivating double-indirection write `(*pp)->X = value`
/// (where `pp` is a pointer-to-a-pointer, `**Point`) alongside the
/// simpler single-parenthesized-receiver write, confirming both that parsing
/// no longer fails and that the write actually lands at runtime.
open class Issue2002ParenthesizedArrowAssignmentEmitTests {
    @Fact
    func ParenthesizedArrowReceiver_Assignment_CompilesAndRuns() {
        let source = PointStruct + `unsafe func run() {
    var arr = []Point{Point{x: 1}}
    var p = &arr[0]
    (p)->x = 42
    Console.WriteLine(arr[0].x)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func DoubleIndirection_ParenthesizedDerefArrow_Assignment_CompilesAndRuns() {
        let source = PointStruct + `unsafe func run() {
    var arr = []Point{Point{x: 1}}
    var p *Point = &arr[0]
    var pp **Point = &p
    Console.WriteLine((*pp)->x)
    (*pp)->x = 77
    Console.WriteLine(arr[0].x)
    Console.WriteLine((*pp)->x)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}77${Environment.NewLine}77${Environment.NewLine}", output)
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        private const PointStruct string = `package Probe
import System

struct Point {
    var x int32
}
`

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2002_").FullName
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
                // Unsafe pointer code is unverifiable by design; tolerate the
                // inherent-unsafety error codes while still gating on other
                // verification regressions.
                IlVerifier.Verify(outPath, nil, UnsafeIlVerifyIgnored)
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
    }
}

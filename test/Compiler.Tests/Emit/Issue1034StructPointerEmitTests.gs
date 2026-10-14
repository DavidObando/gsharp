// <copyright file="Issue1034StructPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1034 / ADR-0122 §4: end-to-end emit + execution tests for unmanaged
/// pointers to blittable user structs (`*S`). Each test compiles via
/// `gsc` and executes the produced assembly under `dotnet exec`,
/// covering deref/index read+write (`ldobj`/`stobj`), arithmetic and
/// pointer difference scaled by the emitted `sizeof S`, member access
/// through the pointer (`(*p).field` and `p->field`), and a
/// round-trip through `nint`.
///
/// Genuinely-unsafe pointer code is unverifiable by design; the inherent
/// error codes are passed to `ignoredErrorCodes` so the gate still
/// catches new unrelated verification regressions (including invalid
/// `ldobj`/`stobj`/`sizeof` tokens) while asserting runtime
/// behavior.
open class Issue1034StructPointerEmitTests {
    @Fact
    func StructPointer_DerefReadWrite_CompilesAndRuns() {
        let source = PointStruct + `unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}}
    var p = &arr[0]
    *p = Point{x: 10, y: 20}
    var v = *p
    Console.WriteLine(v.x)
    Console.WriteLine(v.y)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}20${Environment.NewLine}", output)
    }

    @Fact
    func StructPointer_MemberAccess_DerefAndArrow_CompilesAndRuns() {
        let source = PointStruct + `unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}}
    var p = &arr[0]
    p->x = 11
    (*p).y = 22
    Console.WriteLine(p->x)
    Console.WriteLine((*p).y)
    Console.WriteLine(arr[0].x)
    Console.WriteLine(arr[0].y)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal(
            "11${Environment.NewLine}22${Environment.NewLine}11${Environment.NewLine}22${Environment.NewLine}",
            output
        )
    }

    @Fact
    func StructPointer_CompoundFieldAssignment_EvaluatesPointerOnce() {
        let source = PointStruct + `var calls int32 = 0

unsafe func GetPtr(p *Point) *Point {
    calls += 1
    return p
}

unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}}
    GetPtr(&arr[0])->x += 5
    Console.WriteLine(calls)
    Console.WriteLine(arr[0].x)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}6${Environment.NewLine}", output)
    }

    @Fact
    func StructPointer_IndexingReadWrite_CompilesAndRuns() {
        let source = PointStruct + `unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}, Point{x: 5, y: 6}}
    var p = &arr[0]
    Console.WriteLine(p[2].x)
    p[1] = Point{x: 33, y: 44}
    Console.WriteLine(arr[1].x)
    Console.WriteLine(arr[1].y)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}33${Environment.NewLine}44${Environment.NewLine}", output)
    }

    @Fact
    func StructPointer_ArithmeticAndDifference_ScaledBySizeof_CompilesAndRuns() {
        let source = PointStruct + `unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}, Point{x: 5, y: 6}, Point{x: 7, y: 8}}
    var p = &arr[0]
    var q = p + 3
    Console.WriteLine((*q).x)
    var r = q - 1
    Console.WriteLine((*r).x)
    var d = q - p
    Console.WriteLine(d)
    Console.WriteLine(p - q)
}

run()`
        let output = CompileAndRun(source)
        // q = p + 3 -> arr[3].x == 7; r = q - 1 -> arr[2].x == 5;
        // q - p == 3 and p - q == -3 (scaled by sizeof(Point) == 8 bytes).
        Assert.Equal(
            "7${Environment.NewLine}5${Environment.NewLine}3${Environment.NewLine}-3${Environment.NewLine}",
            output
        )
    }

    @Fact
    func StructPointer_NintRoundTrip_CompilesAndRuns() {
        let source = PointStruct + `unsafe func run() {
    var arr = []Point{Point{x: 1, y: 2}, Point{x: 3, y: 4}}
    var p = &arr[0]
    var addr = nint(p)
    var q = *Point(addr)
    q->x = 99
    Console.WriteLine(arr[0].x)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
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
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var x int32
    var y int32
}
`

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1034_").FullName
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

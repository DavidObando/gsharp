// <copyright file="Issue1014UnmanagedPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1014 / ADR-0122: end-to-end emit + execution tests for unmanaged
/// raw pointers (CLR `ELEMENT_TYPE_PTR`, C# `T*`) inside an
/// `unsafe` context. Each test compiles via `gsc` and executes the
/// produced assembly under `dotnet exec` to assert runtime behavior.
///
/// Genuinely-unsafe pointer code is <em>unverifiable by design</em>: ilverify
/// reports `UnmanagedPointer`, `StackUnexpected`, and
/// `StackByRef` for raw pointer manipulation and address-of of array
/// elements. Those specific codes are passed to `ignoredErrorCodes` so
/// the gate still catches any NEW unrelated verification regressions while
/// tolerating the inherent unsafety, rather than skipping ilverify globally.
open class Issue1014UnmanagedPointerEmitTests {
    @Fact
    func Pointer_DerefReadWrite_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{10, 20, 30}
    var p = &arr[0]
    *p = 99
    Console.WriteLine(*p)
    Console.WriteLine(arr[0])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}99${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_IndexingReadWrite_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{1, 2, 3, 4}
    var p = &arr[0]
    Console.WriteLine(p[2])
    p[3] = 77
    Console.WriteLine(arr[3])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}77${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_Arithmetic_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{5, 6, 7, 8}
    var p = &arr[0]
    var q = p + 2
    Console.WriteLine(*q)
    var r = q - 1
    Console.WriteLine(*r)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}6${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_Difference_Int32_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{1, 2, 3, 4, 5}
    var p = &arr[0]
    var q = &arr[3]
    var d = q - p
    Console.WriteLine(d)
    Console.WriteLine(p - q)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}-3${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_Difference_Int64_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int64{10, 20, 30, 40}
    var p = &arr[0]
    var q = &arr[2]
    Console.WriteLine(q - p)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_Difference_Uint8_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{0, 0}
    var bp = *uint8(&arr[0])
    var bq = bp + 5
    Console.WriteLine(bq - bp)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_CastBetweenPointerTypes_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{42, 0, 0, 0}
    var p = &arr[0]
    var bp = *uint8(p)
    Console.WriteLine(bp[0])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_NintRoundTrip_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{123, 0}
    var p = &arr[0]
    var addr = nint(p)
    var p2 = *int32(addr)
    Console.WriteLine(*p2)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("123${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_Comparison_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{1, 2}
    var p = &arr[0]
    var q = p
    Console.WriteLine(p == q)
    var r = p + 1
    Console.WriteLine(p != r)
    Console.WriteLine(p < r)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_NullPointer_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var np *int32 = nil
    Console.WriteLine(np == nil)
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_FieldOnUnsafeType_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe class Holder {
    var buf *int32
    init(p *int32) {
        buf = p
    }
    func first() int32 {
        return *buf
    }
}

unsafe func run() {
    var arr = []int32{55, 66}
    var h = Holder(&arr[0])
    Console.WriteLine(h.first())
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("55${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_PlainParameter_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func writeThrough(p *int32, value int32) {
    *p = value
}

unsafe func run() {
    var arr = []int32{0, 0}
    writeThrough(&arr[0], 88)
    Console.WriteLine(arr[0])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("88${Environment.NewLine}", output)
    }

    @Fact
    func Pointer_UnsafeBlock_CompilesAndRuns() {
        let source = `package Probe
import System

func run() {
    var arr = []int32{7, 8, 9}
    unsafe {
        var p = &arr[1]
        *p = 100
    }
    Console.WriteLine(arr[1])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("100${Environment.NewLine}", output)
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1014_").FullName
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

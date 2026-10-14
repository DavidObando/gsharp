// <copyright file="Issue1024StackAllocEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issues #1024, #1057, #1041 / ADR-0124: end-to-end emit + execution tests for
/// the `stackalloc [n]T` stack-allocation expression in G#-style array
/// grammar (the bracketed count first, then the element type). The default
/// (safe) form yields a `System.Span<T>` over `localloc`'d
/// memory and requires no `unsafe` context; the pointer form yields the
/// raw `T*` inside an unsafe context. An optional initializer
/// (`stackalloc [n]T{…}` or the count-inferred `stackalloc []T{…}`)
/// stores element values through the `localloc` pointer. Each test
/// compiles via `gsc` and executes the produced assembly under
/// `dotnet exec` to assert runtime behavior.
///
/// Code containing `localloc` is <em>unverifiable by design</em>:
/// ilverify reports `Unverifiable` at the `localloc` site (and the
/// usual unmanaged-pointer codes for the raw-pointer form). Those specific
/// codes are passed to `ignoredErrorCodes` so the gate still catches NEW
/// unrelated verification regressions while tolerating the inherent unsafety,
/// rather than skipping ilverify globally.
open class Issue1024StackAllocEmitTests {
    @Fact
    func SafeSpan_WriteReadLength_CompilesAndRuns() {
        let source = `package Probe
import System

func run() {
    var buf = stackalloc [4]uint8
    buf[0] = uint8(10)
    buf[1] = uint8(20)
    buf[2] = uint8(30)
    buf[3] = uint8(40)
    Console.WriteLine(buf.Length)
    Console.WriteLine(int32(buf[2]))
    var sum = 0
    for var i = 0; i < buf.Length; i++ {
        sum = sum + int32(buf[i])
    }
    Console.WriteLine(sum)
}

run()`
        let output = CompileAndRun(source, SafeSpanIlVerifyIgnored)
        Assert.Equal("4${Environment.NewLine}30${Environment.NewLine}100${Environment.NewLine}", output)
    }

    @Fact
    func SafeSpan_ZeroInitialized_CompilesAndRuns() {
        let source = `package Probe
import System

func run() {
    var buf = stackalloc [4]int32
    Console.WriteLine(buf[0])
    Console.WriteLine(buf[3])
}

run()`
        let output = CompileAndRun(source, SafeSpanIlVerifyIgnored)
        Assert.Equal("0${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func SafeSpan_RuntimeLength_CompilesAndRuns() {
        let source = `package Probe
import System

func fill(n int32) int32 {
    var buf = stackalloc [n]int32
    for var i = 0; i < buf.Length; i++ {
        buf[i] = i * i
    }
    var sum = 0
    for var i = 0; i < buf.Length; i++ {
        sum = sum + buf[i]
    }
    return sum
}

func run() {
    Console.WriteLine(fill(4))
}

run()`
        let output = CompileAndRun(source, SafeSpanIlVerifyIgnored)
        // 0 + 1 + 4 + 9 = 14
        Assert.Equal("14${Environment.NewLine}", output)
    }

    @Fact
    func SafeSpan_InitializerExplicitCount_CompilesAndRuns() {
        let source = `package Probe
import System

func run() {
    var buf = stackalloc [3]int32{10, 20, 30}
    Console.WriteLine(buf.Length)
    Console.WriteLine(buf[0])
    Console.WriteLine(buf[1])
    Console.WriteLine(buf[2])
}

run()`
        let output = CompileAndRun(source, SafeSpanInitializerIlVerifyIgnored)
        Assert.Equal(
            "3${Environment.NewLine}10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}",
            output
        )
    }

    @Fact
    func SafeSpan_InitializerCountInferred_CompilesAndRuns() {
        let source = `package Probe
import System

func run() {
    var buf = stackalloc []int32{1, 2, 3}
    Console.WriteLine(buf.Length)
    var sum = 0
    for var i = 0; i < buf.Length; i++ {
        sum = sum + buf[i]
    }
    Console.WriteLine(sum)
}

run()`
        let output = CompileAndRun(source, SafeSpanInitializerIlVerifyIgnored)
        // 1 + 2 + 3 = 6
        Assert.Equal("3${Environment.NewLine}6${Environment.NewLine}", output)
    }

    @Fact
    func SafeSpan_InitializerByteElements_CompilesAndRuns() {
        let source = `package Probe
import System

func run() {
    var buf = stackalloc []uint8{uint8(5), uint8(15), uint8(25)}
    Console.WriteLine(buf.Length)
    Console.WriteLine(int32(buf[0]))
    Console.WriteLine(int32(buf[2]))
}

run()`
        let output = CompileAndRun(source, SafeSpanInitializerIlVerifyIgnored)
        Assert.Equal("3${Environment.NewLine}5${Environment.NewLine}25${Environment.NewLine}", output)
    }

    @Fact
    func UnsafePointer_WriteRead_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var p *int32 = stackalloc [3]int32
    p[0] = 5
    p[1] = 6
    p[2] = 7
    Console.WriteLine(p[0])
    Console.WriteLine(p[1])
    Console.WriteLine(p[2])
}

run()`
        let output = CompileAndRun(source, UnsafePointerIlVerifyIgnored)
        Assert.Equal("5${Environment.NewLine}6${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func UnsafePointer_ZeroInitialized_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var z *int32 = stackalloc [4]int32
    Console.WriteLine(z[0])
    Console.WriteLine(z[3])
}

run()`
        let output = CompileAndRun(source, UnsafePointerIlVerifyIgnored)
        Assert.Equal("0${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func UnsafePointer_Initializer_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var p *int32 = stackalloc [3]int32{11, 22, 33}
    Console.WriteLine(p[0])
    Console.WriteLine(p[1])
    Console.WriteLine(p[2])
}

run()`
        let output = CompileAndRun(source, UnsafePointerIlVerifyIgnored)
        Assert.Equal("11${Environment.NewLine}22${Environment.NewLine}33${Environment.NewLine}", output)
    }

    @Fact
    func UnsafePointer_InitializerCountInferred_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var p *int32 = stackalloc []int32{7, 8, 9, 10}
    var sum = 0
    for var i = 0; i < 4; i++ {
        sum = sum + p[i]
    }
    Console.WriteLine(sum)
}

run()`
        let output = CompileAndRun(source, UnsafePointerIlVerifyIgnored)
        // 7 + 8 + 9 + 10 = 34
        Assert.Equal("34${Environment.NewLine}", output)
    }

    shared {
        private let SafeSpanIlVerifyIgnored[]string = []string{"Unverifiable"}
        private let UnsafePointerIlVerifyIgnored[]string = []string{
            "Unverifiable",
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        // The safe Span<T> form is normally unverifiable only because of the
        // `localloc` itself. When an initializer is present, the element values are
        // stored through the raw `localloc` pointer (the same indirect-store path as
        // the unsafe pointer form), which trips the additional unmanaged-pointer
        // verification codes — so the initializer safe-form tests ignore the same
        // codes as the unsafe form while still asserting runtime behaviour.
        private let SafeSpanInitializerIlVerifyIgnored[]string = UnsafePointerIlVerifyIgnored

        private func CompileAndRun(source string, ilVerifyIgnored[]string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1024_").FullName
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
                // localloc is unverifiable by design; tolerate the specific
                // localloc/unmanaged-pointer codes while still gating on other
                // verification regressions.
                IlVerifier.Verify(outPath, nil, ilVerifyIgnored)
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

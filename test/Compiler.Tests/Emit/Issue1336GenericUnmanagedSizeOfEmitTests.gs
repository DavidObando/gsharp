// <copyright file="Issue1336GenericUnmanagedSizeOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1336 / Refs #914: end-to-end emit + execution tests for unsafe
/// generic SIMD-style code over an `unmanaged`-constrained type parameter
/// `T`. Covers two capabilities the real Oahu corpus needs:
/// 1. `sizeof(T)` over a generic `T : unmanaged` — lowered to the CIL `sizeof` opcode over a generic
/// type token. This is fully verifiable IL.
/// 2. `*T` (a pointer to the type parameter) over `T : unmanaged`. Like all raw-pointer code this is
/// unverifiable by design, so the inherent pointer error codes are tolerated while still gating other
/// regressions.
open class Issue1336GenericUnmanagedSizeOfEmitTests {
    @Fact
    func SizeOfGenericUnmanaged_CompilesVerifiesAndRuns() {
        let source = `package Probe
import System

func sizeOf[T unmanaged](sample T) int32 {
    return sizeof(T)
}

func run() {
    var a uint8 = 0
    var b int32 = 0
    var c int64 = 0
    Console.WriteLine(sizeOf(a))
    Console.WriteLine(sizeOf(b))
    Console.WriteLine(sizeOf(c))
}

run()`
        // sizeof over a generic type token is fully verifiable IL: no ignored
        // codes — any verification error fails the test. The type argument is
        // inferred from the typed local, so each instantiation emits a distinct
        // generic `sizeof !!T`.
        let output = CompileAndRun(source, Array.Empty[string]())
        Assert.Equal("1${Environment.NewLine}4${Environment.NewLine}8${Environment.NewLine}", output)
    }

    @Fact
    func SizeOfGenericUnmanaged_VecLaneCount_CompilesAndRuns() {
        // Mirrors the Oahu driver: 256 / 8 / sizeof(T) lane count.
        let source = `package Probe
import System

func laneCount[T unmanaged](sample T) int32 {
    return 256 / 8 / sizeof(T)
}

func run() {
    var a uint8 = 0
    var b int16 = 0
    var c int32 = 0
    Console.WriteLine(laneCount(a))
    Console.WriteLine(laneCount(b))
    Console.WriteLine(laneCount(c))
}

run()`
        let output = CompileAndRun(source, Array.Empty[string]())
        Assert.Equal("32${Environment.NewLine}16${Environment.NewLine}8${Environment.NewLine}", output)
    }

    @Fact
    func PointerToGenericUnmanaged_CompilesVerifiesAndRuns() {
        let source = `package Probe
import System

unsafe func writeFirst[T unmanaged](arr []T, value T) {
    var p = &arr[0]
    *p = value
}

unsafe func run() {
    var arr = []int32{0, 0, 0}
    writeFirst[int32](arr, 42)
    Console.WriteLine(arr[0])
}

run()`
        // Raw pointer code is unverifiable by design; tolerate the inherent
        // pointer codes while still gating other verification regressions.
        let output = CompileAndRun(source, UnsafeIlVerifyIgnored)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        private func CompileAndRun(source string, ignoredIlVerifyCodes[]string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1336_").FullName
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
                IlVerifier.Verify(outPath, nil, ignoredIlVerifyCodes)
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

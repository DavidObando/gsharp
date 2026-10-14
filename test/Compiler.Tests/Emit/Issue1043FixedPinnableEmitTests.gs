// <copyright file="Issue1043FixedPinnableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1043 / ADR-0125: end-to-end emit + execution tests for pinning a
/// span-like source via `GetPinnableReference` in a `fixed` statement
/// (`fixed <name> *T = <span> { ... }`). The statement pins the
/// `T&` returned by a public instance `ref T GetPinnableReference()`
/// (canonically `System.Span[T]` / `System.ReadOnlySpan[T]`) into a
/// `T& pinned` local and derives an unmanaged `*T` pointer via
/// `conv.u`, mirroring C# `fixed (T* p = span)`.
///
/// The critical regression this guards is that
/// `ReadOnlySpan[T].GetPinnableReference()` has a `ref readonly T`
/// return carrying `modreq(System.Runtime.InteropServices.InAttribute)`; the
/// emitted MemberRef must reproduce that modreq exactly or the call fails at
/// runtime with `System.MissingMethodException`. Each test compiles via
/// `gsc`, ilverifies (tolerating the inherent unmanaged-pointer codes), and
/// executes under `dotnet exec` to assert runtime behavior.
open class Issue1043FixedPinnableEmitTests {
    @Fact
    func SpanPin_WriteRead_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var buf = []uint8{uint8(0), uint8(0), uint8(0)}
    var sp Span[uint8] = buf
    fixed pD *uint8 = sp {
        pD[0] = uint8(65)
        pD[1] = uint8(66)
        pD[2] = uint8(67)
    }
    Console.WriteLine(int32(buf[0]))
    Console.WriteLine(int32(buf[1]))
    Console.WriteLine(int32(buf[2]))
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        Assert.Equal("65${Environment.NewLine}66${Environment.NewLine}67${Environment.NewLine}", output)
    }

    @Fact
    func ReadOnlySpanPin_ReadThroughModreqRef_CompilesAndRuns() {
        // `ReadOnlySpan[T].GetPinnableReference()` returns `ref readonly T`
        // (a `modreq(InAttribute)` ref-return); reading through the pinned
        // pointer exercises the modreq-bearing MemberRef at runtime.
        let source = `package Probe
import System

unsafe func run() {
    var buf = []uint8{uint8(10), uint8(20), uint8(30)}
    var ros ReadOnlySpan[uint8] = buf
    var total = 0
    fixed pR *uint8 = ros {
        for var i = 0; i < 3; i++ {
            total = total + int32(pR[i])
        }
    }
    Console.WriteLine(total)
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        // 10 + 20 + 30 = 60
        Assert.Equal("60${Environment.NewLine}", output)
    }

    @Fact
    func SpanPin_RoundTripThroughDerefWrite_CompilesAndRuns() {
        // Writes through the raw `*T` derived from the span pin must be visible
        // in the underlying backing array (the span aliases `buf`).
        let source = `package Probe
import System

unsafe func fill(buf []uint8, value uint8) {
    var sp Span[uint8] = buf
    fixed p *uint8 = sp {
        *p = value
    }
}

unsafe func run() {
    var dst = []uint8{uint8(0), uint8(0)}
    fill(dst, uint8(42))
    Console.WriteLine(int32(dst[0]))
    Console.WriteLine(int32(dst[1]))
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        Assert.Equal("42${Environment.NewLine}0${Environment.NewLine}", output)
    }

    shared {
        private let FixedIlVerifyIgnored[]string = []string{
            "Unverifiable",
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType",
            "ExpectedNumericType"
        }

        private func CompileAndRun(source string, ilVerifyIgnored[]string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1043_").FullName
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
                // Pinning + unmanaged-pointer dereference is unverifiable by
                // design; tolerate the specific pointer/by-ref codes while still
                // gating on other verification regressions (incl. a malformed
                // GetPinnableReference modreq signature).
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

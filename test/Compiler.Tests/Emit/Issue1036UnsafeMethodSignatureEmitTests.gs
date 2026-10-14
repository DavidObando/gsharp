// <copyright file="Issue1036UnsafeMethodSignatureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1036 / ADR-0122 §1: end-to-end emit + execution tests for an
/// `unsafe func` method declared inside an otherwise-<em>safe</em> type.
/// The method's SIGNATURE (parameter + return types) binds in an unsafe
/// context, so it may take/return unmanaged raw pointers (`*T` →
/// CLR `ELEMENT_TYPE_PTR`) without marking the whole type
/// `unsafe class` / `unsafe struct`. Each test compiles via
/// `gsc` and executes the produced assembly under `dotnet exec` to
/// assert runtime behavior.
///
/// Genuinely-unsafe pointer code is unverifiable by design, so the inherent
/// pointer verification codes are passed to `ignoredErrorCodes` while
/// still gating on any NEW unrelated verification regressions.
open class Issue1036UnsafeMethodSignatureEmitTests {
    @Fact
    func UnsafeMethod_InSafeClass_PointerParamAndReturn_CompilesAndRuns() {
        let source = `package Probe
import System

class Safe {
    unsafe func bump(p *int32) *int32 {
        *p = *p + 1
        return p
    }
}

unsafe func run() {
    var arr = []int32{41}
    var s = Safe()
    var q = s.bump(&arr[0])
    Console.WriteLine(*q)
    Console.WriteLine(arr[0])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func UnsafeMethod_InSafeStruct_PointerParamAndReturn_CompilesAndRuns() {
        let source = `package Probe
import System

struct Safe {
    unsafe func bump(p *int32) *int32 {
        *p = *p + 10
        return p
    }
}

unsafe func run() {
    var arr = []int32{5}
    var s = Safe{}
    var q = s.bump(&arr[0])
    Console.WriteLine(*q)
    Console.WriteLine(arr[0])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}15${Environment.NewLine}", output)
    }

    @Fact
    func UnsafeStaticMethod_InSafeClass_PointerParam_CompilesAndRuns() {
        let source = `package Probe
import System

class Safe {
    shared {
        unsafe func add(p *int32, n int32) {
            *p = *p + n
        }
    }
}

unsafe func run() {
    var arr = []int32{100}
    Safe.add(&arr[0], 23)
    Console.WriteLine(arr[0])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("123${Environment.NewLine}", output)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1036_").FullName
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

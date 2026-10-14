// <copyright file="Issue1906FunctionPointerFromClassMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1906: `&Method` (`ldftn`, ADR-0122 §9) taken on a
/// `shared` method declared inside a class/struct — as opposed to a
/// top-level package function (already covered by
/// (cref:Issue1035FunctionPointerEmitTests)) — used to throw
/// `InvalidOperationException: Function 'X' has no emitted MethodDef for
/// '&X' (ldftn)` at compile time: the emitter only consulted
/// `MetadataTokenCache.FunctionHandles` (top-level functions), never
/// `MetadataTokenCache.MethodHandles` (class/struct methods), so a
/// method reachable ONLY via its address (never called directly) had no
/// registered `MethodDef` to reference. This surfaced when the cs2gs
/// translator started mapping C# `delegate*<...>` to G#'s managed
/// function-pointer form, since a translated C# static method lives in a
/// `shared {}` block, not as a free function.
open class Issue1906FunctionPointerFromClassMethodEmitTests {
    @Fact
    func FunctionPointer_AddressOfSharedClassMethod_CompilesAndRuns() {
        const source = `package Probe
import System

class Calc {
    shared {
        unsafe func Square(value int32) int32 {
            return value * value
        }
    }
}

unsafe func run() {
    let fp *func(int32) int32 = &Calc.Square
    Console.WriteLine(fp(6))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("36${Environment.NewLine}", output)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1906_").FullName
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
                // verification regressions (including invalid ldftn tokens).
                // dotnet-ilverify does not implement verification of the `calli`
                // opcode ("ImportCalli not implemented"); that is a limitation of
                // the verifier tool, not of the emitted IL, so we tolerate that
                // specific failure and rely on the runtime execution below as the
                // correctness gate for the calli path.
                try {
                    IlVerifier.Verify(outPath, nil, UnsafeIlVerifyIgnored)
                } catch (ex Exception) when ex.Message.Contains(
                    "ImportCalli not implemented",
                    StringComparison.Ordinal
                ) {
                    // Known dotnet-ilverify limitation for `calli`; ignore.

                }
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

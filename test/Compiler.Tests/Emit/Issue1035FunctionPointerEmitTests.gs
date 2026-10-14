// <copyright file="Issue1035FunctionPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1035 / ADR-0122 §9: end-to-end emit + execution tests for managed
/// function pointers (`*func(T1, T2) R`). Each test compiles via
/// `gsc` and executes the produced assembly under `dotnet exec`,
/// covering `&StaticMethod` (`ldftn`), direct invocation
/// (`calli`), passing a function pointer as a parameter, and a round-trip
/// through `nint`.
///
/// Genuinely-unsafe pointer code is unverifiable by design; the inherent
/// error codes are passed to `ignoredErrorCodes` so the gate still
/// catches new unrelated verification regressions (including invalid
/// `ldftn`/`calli` tokens) while asserting runtime behavior.
open class Issue1035FunctionPointerEmitTests {
    @Fact
    func FunctionPointer_AddressOfAndCall_CompilesAndRuns() {
        const source = `package Probe
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func run() {
    let fp *func(int32, int32) int32 = &add
    Console.WriteLine(fp(3, 4))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func FunctionPointer_NamedArguments_UseTargetMethodParameterNames() {
        const source = `package Probe
import System

unsafe func subtract(x int32, y int32) int32 {
    return x - y
}

unsafe func run() {
    let fp *func(int32, int32) int32 = &subtract
    Console.WriteLine(fp(y: 3, x: 10))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func FunctionPointer_PassAsParameter_CompilesAndRuns() {
        const source = `package Probe
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func mul(a int32, b int32) int32 {
    return a * b
}

unsafe func apply(fp *func(int32, int32) int32, x int32, y int32) int32 {
    return fp(x, y)
}

unsafe func run() {
    Console.WriteLine(apply(&add, 10, 20))
    Console.WriteLine(apply(&mul, 6, 7))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("30${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func FunctionPointer_VoidReturn_CompilesAndRuns() {
        const source = `package Probe
import System

unsafe func greet() {
    Console.WriteLine("hi")
}

unsafe func run() {
    let fp *func() = &greet
    fp()
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func FunctionPointer_NintRoundTrip_CompilesAndRuns() {
        const source = `package Probe
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func run() {
    let fp *func(int32, int32) int32 = &add
    let n nint = nint(fp)
    Console.WriteLine(n != nint(0))
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Theory
    @InlineData("*func(int32) int32")
    @InlineData("unmanaged[Cdecl] (int32) -> int32")
    func FunctionPointer_NilParameter_CompilesAndRuns(pointerType string) {
        let source = (`package Probe
import System

unsafe func printPointer(fp ` + "$pointerType" + `) {
    Console.WriteLine(nint(fp))
}

printPointer(nil)`)
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1035_").FullName
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

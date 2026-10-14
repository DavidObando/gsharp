// <copyright file="Issue1522StackAllocArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1522 — a `stackalloc [n]T` used as a METHOD/CONSTRUCTOR ARGUMENT
/// (or any operand evaluated with a non-empty evaluation stack) emitted its CIL
/// `localloc` INLINE while the receiver and/or previously-evaluated
/// arguments were still on the stack. ECMA-335 III.3.47 requires the stack to be
/// empty (except the size item) at `localloc`, so ilverify reported
/// `LocallocStackNotEmpty` (plus a paired `Unverifiable` at the same
/// offset). The JIT accepted it, but the IL was invalid.
///
/// The fix spills every non-statement-root `stackalloc` to a pre-allocated
/// result local: the method-body planner reserves a result-typed slot
/// (`Span<T>` for the safe form, `T*`/`void*` for the
/// pointer form) and the emitter materialises the `localloc` into that
/// local at an empty-stack point (statement start, in source order) before
/// loading it at the original operand position.
///
/// A residual bare `Unverifiable` on the `localloc` instruction itself
/// is by-design (localloc is valid-but-never-verifiable, see ADR-0124) and is
/// the ONLY tolerated code — `LocallocStackNotEmpty` is NOT ignored, so a
/// regression re-fails the gate. Each test uses a UNIQUE package/type name
/// because the in-process `FunctionTypeSymbol` cache is name-keyed.
open class Issue1522StackAllocArgEmitTests {
    @Fact
    func InstanceMethodArgument_SpillsStackAlloc_VerifiesAndRuns() {
        // The repro from the issue: an instance-method call whose receiver is on
        // the stack when the stackalloc argument is evaluated.
        const source = `package i1522instance
import System

class Sink1522Inst { func Take(s Span[uint8]) int32 -> s.Length }

func Use(sink Sink1522Inst) int32 { return sink.Take(stackalloc [2]uint8) }

func Main() { Console.WriteLine(Use(Sink1522Inst())) }`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func StaticMethodSecondArgument_SpillsStackAlloc_VerifiesAndRuns() {
        // A static method's 2nd argument: the first argument (10) is already on
        // the stack when the stackalloc is evaluated.
        const source = `package i1522static
import System

func Foo1522(a int32, s Span[uint8]) int32 -> a + s.Length

func Use() int32 { return Foo1522(10, stackalloc [2]uint8) }

func Main() { Console.WriteLine(Use()) }`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}", output)
    }

    @Fact
    func ConstructorArgument_SpillsStackAlloc_VerifiesAndRuns() {
        // A constructor argument (the newobj is pending on the eval stack).
        const source = `package i1522ctor
import System

class Thing1522 {
    var N int32 = 0
    init(s Span[uint8]) { N = s.Length }
}

func Use() int32 {
    var t = Thing1522(stackalloc [3]uint8)
    return t.N
}

func Main() { Console.WriteLine(Use()) }`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func StatementPositionStackAlloc_StillVerifiesAndRuns() {
        // Regression guard: a statement-root `var x = stackalloc …` is NOT
        // spilled (it already emits at an empty stack) and keeps working.
        const source = `package i1522stmt
import System

func Use() int32 {
    var buf = stackalloc [4]uint8
    buf[0] = uint8(1)
    buf[3] = uint8(9)
    return buf.Length + int32(buf[3])
}

func Main() { Console.WriteLine(Use()) }`
        let output = CompileAndRun(source)
        Assert.Equal("13${Environment.NewLine}", output)
    }

    shared {
        // Only the inherent `localloc` Unverifiable is tolerated. LocallocStackNotEmpty
        // is deliberately NOT ignored so this gate still catches the original bug.
        private let LocallocIlVerifyIgnored[]string = []string{"Unverifiable"}

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1522_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(
                    dllPath,
                    ignoredErrorCodes: LocallocIlVerifyIgnored,
                    ignoredErrorScope: "<Program>\\.Use$$"
                )
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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

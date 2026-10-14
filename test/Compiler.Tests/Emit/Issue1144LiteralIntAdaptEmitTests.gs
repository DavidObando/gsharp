// <copyright file="Issue1144LiteralIntAdaptEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1144: end-to-end emit + execution tests proving a constant integer
/// literal operand of a binary operator adapts to the OTHER operand's integer
/// type and is emitted with that type. Each program compiles via `gsc`,
/// is IL-verified, and runs under `dotnet exec` with its runtime values
/// asserted — including an unsigned-arithmetic check to confirm the literal is
/// emitted as the unsigned operand type (not int32).
open class Issue1144LiteralIntAdaptEmitTests {
    @Fact
    func UInt32Increment_LiteralAdapts_AndRuns() {
        let source = `package main
import System

func F(a uint32) uint32 { return a + 1 }

func run() {
    Console.WriteLine(F(uint32(10)))
}

run()`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UInt8BitwiseOr_LiteralAdapts_AndRuns() {
        let source = `package main
import System

func G(b uint8) int32 { return int32(b | 4) }

func run() {
    Console.WriteLine(G(uint8(1)))
}

run()`
        // 1 | 4 == 5
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UInt8Equality_LiteralAdapts_AndRuns() {
        let source = `package main
import System

func H(c uint8) bool { return c == 0 }

func run() {
    Console.WriteLine(H(uint8(0)))
    Console.WriteLine(H(uint8(5)))
}

run()`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UInt32Wrap_LiteralEmittedAsUnsigned_NotInt32() {
        // If the literal `1` were emitted as int32 and the addition performed
        // as signed int32, `0xFFFFFFFF + 1` would overflow into a negative
        // int32. Adapting the literal to uint32 makes this wrap to 0 as
        // unsigned arithmetic — proving the emitted operand type.
        let source = `package main
import System

func F(a uint32) uint32 { return a + 1 }

func run() {
    var max = 4294967295U
    Console.WriteLine(F(max))
}

run()`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Int64Operand_LiteralAdapts_AndRuns() {
        let source = `package main
import System

func F(l int64) int64 { return l + 1 }

func run() {
    Console.WriteLine(F(9223372036854775806L))
}

run()`
        Assert.Equal("9223372036854775807${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1144_").FullName
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
                IlVerifier.Verify(outPath, nil, Array.Empty[string]())
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

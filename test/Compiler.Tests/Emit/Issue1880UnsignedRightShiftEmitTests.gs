// <copyright file="Issue1880UnsignedRightShiftEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1880 — G# had no unsigned (logical) right-shift operator, so a
/// translated `>>>`/`>>>=` from C# either crashed cs2gs stage-1 (unknown
/// binary operator) or round-tripped to unparsable G# source. This adds the
/// `>>>` binary operator and `>>>=` compound-assign operator to the G#
/// language itself, emitting CLR `shr.un` regardless of the operand's
/// signedness (unlike `>>`, which emits `shr` for signed operands). Covers
/// int32, uint32, and int64, verifying the result differs from `>>` on a
/// negative operand.
open class Issue1880UnsignedRightShiftEmitTests {
    @Fact
    func EndToEnd_Int32_UnsignedShiftRight_DiffersFromArithmeticShift() {
        const source = `package i1880int32
import System

func Main() {
    var negative int32 = -8
    var logical = negative >>> 1
    var arithmetic = negative >> 1
    System.Console.WriteLine(logical)
    System.Console.WriteLine(arithmetic)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "${unchecked(int32((uint32((-8)) >> 1)))}${Environment.NewLine}${-8 >> 1}${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_Int32_UnsignedShiftRightAssign_MutatesInPlace() {
        const source = `package i1880int32compound
import System

func Main() {
    var v int32 = -8
    v >>>= 1
    System.Console.WriteLine(v)
}`
        let output = CompileAndRun(source)
        Assert.Equal("${unchecked(int32((uint32((-8)) >> 1)))}${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UInt32_UnsignedShiftRight_MatchesPlainShift() {
        const source = `package i1880uint32
import System

func Main() {
    var v uint32 = 4294967288u
    var logical = v >>> 1
    var arithmetic = v >> 1
    System.Console.WriteLine(logical)
    System.Console.WriteLine(arithmetic)
}`
        let output = CompileAndRun(source)
        Assert.Equal("${4294967288u >> 1}${Environment.NewLine}${4294967288u >> 1}${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Int64_UnsignedShiftRight_DiffersFromArithmeticShift() {
        const source = `package i1880int64
import System

func Main() {
    var negative int64 = -8L
    var logical = negative >>> 1
    var arithmetic = negative >> 1
    System.Console.WriteLine(logical)
    System.Console.WriteLine(arithmetic)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "${unchecked(int64((uint64((-8L)) >> 1)))}${Environment.NewLine}${-8L >> 1}${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1880_exe_").FullName
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
                IlVerifier.Verify(dllPath)
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

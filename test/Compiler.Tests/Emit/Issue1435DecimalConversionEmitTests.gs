// <copyright file="Issue1435DecimalConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1435 — explicit conversions FROM `decimal` to any numeric
/// target. (cref:decimal) declares many `op_Explicit(decimal)`
/// overloads that differ only by return type, so seeding the operator lookup
/// with `Type.GetMethod("op_Explicit", new[] { typeof(decimal) })` threw
/// (cref:System.Reflection.AmbiguousMatchException) and surfaced as a
/// GS9998 internal compiler error for EVERY decimal->numeric conversion.
/// The fix disambiguates the operator by both parameter and return type.
/// These tests compile + run a conversion to each numeric target end-to-end.
open class Issue1435DecimalConversionEmitTests {
    @Fact
    func EndToEnd_DecimalToAllNumericTargets_Runs() {
        let source = `package Probe1435a
import System

func Main() {
    let d decimal = 42

    Console.WriteLine(int8(d))
    Console.WriteLine(uint8(d))
    Console.WriteLine(int16(d))
    Console.WriteLine(uint16(d))
    Console.WriteLine(int32(d))
    Console.WriteLine(uint32(d))
    Console.WriteLine(int64(d))
    Console.WriteLine(uint64(d))
    Console.WriteLine(float32(d))
    Console.WriteLine(float64(d))
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_DecimalToUInt64_FromMethod_Runs() {
        let source = `package Probe1435b
import System

class Holder1435b {
    func ToU64(d decimal) uint64 -> uint64(d)
}

func Main() {
    let h = Holder1435b()
    Console.WriteLine(h.ToU64(decimal(123)))
}`
        let output = CompileAndRun(source)
        Assert.Equal("123${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DecimalToInt32_Truncates_Runs() {
        let source = `package Probe1435c
import System

func Main() {
    let d decimal = 7
    let half decimal = d / decimal(2)
    Console.WriteLine(int32(half))
}`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1435_exe_").FullName
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

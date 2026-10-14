// <copyright file="Issue1733FloatInfinityDefaultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1733 N1: `cs2gs` emits a `double`/`float`
/// `PositiveInfinity`/`NegativeInfinity` default as the qualified BCL
/// member reference `System.Double.PositiveInfinity`/`NegativeInfinity`
/// (and the `System.Single` equivalents) — the same spelling
/// `Issue1616FloatNaNOperatorEmitTests` already proves G# resolves for
/// `System.Double.NaN`/`System.Single.NaN`. This end-to-end emit test
/// proves G# ALSO resolves the `PositiveInfinity`/`NegativeInfinity`
/// spelling for both `double` and `float`, confirming the cs2gs emitted
/// spelling is correct (not just NaN).
open class Issue1733FloatInfinityDefaultEmitTests {
    @Fact
    func EndToEnd_Float64_PositiveAndNegativeInfinity_Resolve() {
        const source = `package i1733f64inf
import System

func Main() {
    var posInf = System.Double.PositiveInfinity
    var negInf = System.Double.NegativeInfinity
    System.Console.WriteLine(posInf)
    System.Console.WriteLine(negInf)
    System.Console.WriteLine(posInf > 1.0)
    System.Console.WriteLine(negInf < -1.0)
}`
        let output = CompileAndRun(source)
        let expected = "${float64.PositiveInfinity}${Environment.NewLine}" +
            "${float64.NegativeInfinity}${Environment.NewLine}" +
            "True${Environment.NewLine}True${Environment.NewLine}"
        Assert.Equal(expected, output)
    }

    @Fact
    func EndToEnd_Float32_PositiveAndNegativeInfinity_Resolve() {
        const source = `package i1733f32inf
import System

func Main() {
    var posInf = System.Single.PositiveInfinity
    var negInf = System.Single.NegativeInfinity
    System.Console.WriteLine(posInf)
    System.Console.WriteLine(negInf)
    System.Console.WriteLine(posInf > float32(1.0))
    System.Console.WriteLine(negInf < float32(-1.0))
}`
        let output = CompileAndRun(source)
        let expected = "${float32.PositiveInfinity}${Environment.NewLine}" +
            "${float32.NegativeInfinity}${Environment.NewLine}" +
            "True${Environment.NewLine}True${Environment.NewLine}"
        Assert.Equal(expected, output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1733inf_exe_").FullName
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

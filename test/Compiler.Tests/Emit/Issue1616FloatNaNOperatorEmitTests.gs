// <copyright file="Issue1616FloatNaNOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1616: float `<=`/`>=` operator emit
/// (`MethodBodyEmitter.Operators.cs` `EmitBinary` and the lifted
/// `EmitUnderlyingOrdering`) lowered `a <= b` / `a >= b` as `!(a
/// cgt b)` / `!(a clt b)` using the ORDERED `cgt`/`clt` opcodes.
/// Ordered comparisons return false for NaN, so negating them yielded
/// `true` for e.g. `NaN <= 1.0` — wrong per IEEE 754. Fix uses
/// the unordered `cgt.un`/`clt.un` forms for float operands (as the
/// relational-pattern emit path already did), so negation correctly yields
/// `false` whenever an operand is NaN.
open class Issue1616FloatNaNOperatorEmitTests {
    @Fact
    func EndToEnd_Float64_NaNLessOrEqualGreaterOrEqual_AreFalse() {
        const source = `package i1616f64op
import System

func Main() {
    var nan = System.Double.NaN
    var one = 1.0
    System.Console.WriteLine(nan <= one)
    System.Console.WriteLine(one <= nan)
    System.Console.WriteLine(nan >= one)
    System.Console.WriteLine(one >= nan)
    System.Console.WriteLine(one <= 2.0)
    System.Console.WriteLine(2.0 >= one)
    System.Console.WriteLine(one <= 1.0)
    System.Console.WriteLine(one >= 1.0)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_Float32_NaNLessOrEqualGreaterOrEqual_AreFalse() {
        const source = `package i1616f32op
import System

func Main() {
    var nan = float32(System.Single.NaN)
    var one = float32(1.0)
    var two = float32(2.0)
    System.Console.WriteLine(nan <= one)
    System.Console.WriteLine(one <= nan)
    System.Console.WriteLine(nan >= one)
    System.Console.WriteLine(one >= nan)
    System.Console.WriteLine(one <= two)
    System.Console.WriteLine(two >= one)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_LiftedFloat64Nullable_NaNLessOrEqualGreaterOrEqual_AreFalse() {
        const source = `package i1616f64liftop
import System

func Main() {
    var nan float64? = System.Double.NaN
    var one float64? = 1.0
    var two float64? = 2.0
    System.Console.WriteLine(nan <= one)
    System.Console.WriteLine(one <= nan)
    System.Console.WriteLine(nan >= one)
    System.Console.WriteLine(one >= nan)
    System.Console.WriteLine(one <= two)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1616nan_exe_").FullName
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

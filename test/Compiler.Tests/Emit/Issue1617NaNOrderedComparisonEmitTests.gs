// <copyright file="Issue1617NaNOrderedComparisonEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1617 (drift 2): the IEEE-754-aware NaN handling for the ordered
/// `<=` / `>=` comparisons on `float32`/`float64` had
/// reached the relational-pattern emit copy but NOT the two binary-operator
/// emit copies (`EmitBinary` and the lifted-nullable
/// `EmitUnderlyingOrdering`). Those copies emitted the signed
/// `cgt`/`clt` for `<=`/`>=`, which the `ldc.i4.0;
/// ceq` negation turns into `true` when an operand is NaN — the wrong
/// answer. The fix routes float `<=`/`>=` through the unordered
/// `cgt.un`/`clt.un` variants so a NaN operand yields `false`,
/// matching IEEE-754 and Roslyn.
///
/// Each test uses a UNIQUE package name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed and not cleared between tests.
open class Issue1617NaNOrderedComparisonEmitTests {
    @Fact
    func EndToEnd_NaNLessOrEqualGreaterOrEqual_Operators_AreFalse() {
        // `nan` is a runtime local (not a compile-time constant) so the
        // comparisons are emitted through EmitBinary rather than folded.
        const source = `package i1617nanop
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
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_NaNLessOrEqualGreaterOrEqual_NullableOperators_AreFalse() {
        // Nullable float `<=`/`>=` route through the lifted
        // EmitUnderlyingOrdering copy; both operands are non-null here so the
        // result is driven purely by the underlying NaN comparison.
        const source = `package i1617nannullable
import System

func Main() {
    var nan float64? = System.Double.NaN
    var one float64? = 1.0
    System.Console.WriteLine(nan <= one)
    System.Console.WriteLine(one <= nan)
    System.Console.WriteLine(nan >= one)
    System.Console.WriteLine(one >= nan)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_Float32NaNLessOrEqual_Operator_IsFalse() {
        const source = `package i1617nanfloat32
import System

func Main() {
    var nan float32 = System.Single.NaN
    var one = float32(1.0)
    var two = float32(2.0)
    System.Console.WriteLine(nan <= one)
    System.Console.WriteLine(one >= nan)
    System.Console.WriteLine(one <= two)
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1617nan_exe_").FullName
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

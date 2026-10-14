// <copyright file="Issue1556ReceiverDefaultParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1556 — a receiver-form (extension-style) function
/// `func (x T) M(a A, b B = <default>) R` could not be called with a
/// trailing defaulted parameter omitted: the binder validated against the full
/// parameter count and reported GS0144 ("requires N arguments but was given
/// N-1") without filling the trailing defaults. The equivalent free-function
/// and static (`shared`) call paths already synthesized omitted trailing
/// slots from each parameter's captured default constant (ADR-0063 / issues
/// #936, #1319).
///
/// The fix teaches `OverloadResolver.BindExtensionFunctionCall` to count
/// the leading non-optional user parameters (the receiver occupies
/// `Parameters[0]`, so the scan runs over `Parameters[1..]`), accept
/// any argument count in `[required, total]`, and pad the omitted trailing
/// slots from each parameter's captured default value before the generic
/// inference and per-position conversion loops — exactly as the free-function,
/// static, and user-instance call paths do.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue1556ReceiverDefaultParamEmitTests {
    @Fact
    func EndToEnd_ValueReceiver_OneTrailingDefaultOmitted_Runs() {
        const source = `package i1556one
import System

func (x int32) Combine1556(a int32, b int32 = 5) int32 -> x + a + b

func Main() {
    let v = 3
    Console.WriteLine(v.Combine1556(1))
}`
        let output = CompileAndRun(source)
        Assert.Equal("9${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ValueReceiver_AllTrailingDefaultsOmitted_Runs() {
        const source = `package i1556all
import System

func (x int32) C21556(a int32 = 2, b int32 = 5) int32 -> x + a + b

func Main() {
    let v = 3
    Console.WriteLine(v.C21556())
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ValueReceiver_AllArgumentsSupplied_Runs() {
        const source = `package i1556full
import System

func (x int32) CombineFull1556(a int32, b int32 = 5) int32 -> x + a + b

func Main() {
    let v = 3
    Console.WriteLine(v.CombineFull1556(1, 9))
}`
        let output = CompileAndRun(source)
        Assert.Equal("13${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserStructReceiver_TrailingDefaultOmitted_Runs() {
        const source = `package i1556struct
import System

struct Pt1556(X int32) { }

func (p Pt1556) Shift1556(dx int32, dy int32 = 100) int32 -> p.X + dx + dy

func Main() {
    Console.WriteLine(Pt1556(3).Shift1556(1))
    Console.WriteLine(Pt1556(3).Shift1556(1, 9))
}`
        let output = CompileAndRun(source)
        Assert.Equal("104${Environment.NewLine}13${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ReferenceStringReceiver_TrailingDefaultOmitted_Runs() {
        const source = `package i1556string
import System

func (s string) Rep1556(n int32 = 2) string {
    var r = ""
    for var i = 0; i < n; i = i + 1 { r = r + s }
    return r
}

func Main() {
    Console.WriteLine("ab".Rep1556())
    Console.WriteLine("ab".Rep1556(3))
}`
        let output = CompileAndRun(source)
        Assert.Equal("abab${Environment.NewLine}ababab${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BclTypeReceiver_TrailingDefaultOmitted_Runs() {
        const source = `package i1556type
import System

func (t Type) Label1556(level int32? = nil, full bool = false) int32 -> if level != nil { level!! } else { 0 }

func Main() {
    let t = typeof(int32)
    Console.WriteLine(t.Label1556(7))
    Console.WriteLine(t.Label1556())
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NilNullableDefault_Omitted_Runs() {
        const source = `package i1556nil
import System

func (x int32?) OrElse1556(fallback int32? = nil) int32 -> if fallback != nil { fallback!! } else { 5 }

func Main() {
    var y int32? = 7
    Console.WriteLine(y.OrElse1556())
    Console.WriteLine(y.OrElse1556(42))
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_GenericReceiverForm_TrailingDefaultOmitted_Runs() {
        const source = `package i1556generic
import System

func (x int32) Gen1556[T](tag T, extra int32 = 11) int32 -> x + extra

func Main() {
    Console.WriteLine((3).Gen1556[string]("hi"))
    Console.WriteLine((3).Gen1556[string]("hi", 100))
}`
        let output = CompileAndRun(source)
        Assert.Equal("14${Environment.NewLine}103${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_OverloadDisambiguation_DefaultsParticipate_SelectsCorrectly() {
        const source = `package i1556overload
import System

func (x int32) Ov1556(a int32, b int32 = 5) int32 -> x + a + b
func (x int32) Ov1556(a string) int32 -> x + a.Length

func Main() {
    Console.WriteLine((10).Ov1556(1))
    Console.WriteLine((10).Ov1556("abc"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("16${Environment.NewLine}13${Environment.NewLine}", output)
    }

    @Fact
    func Negative_RequiredParameterOmitted_ReportsGs0144() {
        // Omitting a REQUIRED (non-defaulted) parameter still reports GS0144;
        // only trailing defaulted parameters may be omitted.
        const source = `package i1556neg
import System

func (x int32) Need1556(a int32, b int32 = 5) int32 -> x + a + b

func Main() {
    Console.WriteLine((10).Need1556())
}`
        let (exit, output) = CompileOnly(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0144", output)
    }

    @Fact
    func Control_FreeFunctionDefault_StillRuns() {
        // Regression guard: the free-function default-parameter path that
        // already worked must keep working.
        const source = `package i1556free
import System

func F1556(x int32, a int32, b int32 = 5) int32 -> x + a + b

func Main() {
    Console.WriteLine(F1556(3, 1))
    Console.WriteLine(F1556(3, 1, 9))
}`
        let output = CompileAndRun(source)
        Assert.Equal("9${Environment.NewLine}13${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1556_exe_").FullName
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

        private func CompileOnly(source string)(Exit int32, Output string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1556_neg_").FullName
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
                return (compileExit, stdoutWriter.ToString() + stderrWriter.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

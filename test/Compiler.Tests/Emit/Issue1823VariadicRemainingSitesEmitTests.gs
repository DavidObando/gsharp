// <copyright file="Issue1823VariadicRemainingSitesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1823 — follow-up to #1630. That fix extracted
/// `PackOrPassThroughVariadicArguments` in `OverloadResolver` and
/// routed the 7 variadic pack sites there through it, but three sibling
/// sites OUTSIDE `OverloadResolver` still packed raw, uncoerced trailing
/// elements: a struct field of function type invoked directly
/// (`TryBindUserStructDelegateFieldInvocation`), a named-CLR-delegate
/// `.Invoke(args)` call (`BindNamedDelegateInvokeCall`), and a
/// generic static method fallback with type-argument substitution
/// (`BindUserTypeStaticCall`). Each case below packs an `int32`
/// element into a variadic `...int64` slot — a widening conversion the
/// #1493/#1630 per-element coercion is supposed to guarantee — and asserts
/// the widened value is actually observed at runtime (not merely that the
/// call compiles/verifies).
open class Issue1823VariadicRemainingSitesEmitTests {
    @Fact
    func EndToEnd_StructFieldOfFunctionTypeDirectCall_CoercesElementsToInt64_Runs() {
        let source = `package Probe1823a
import System

class Container1823a {
    var callback (...int64) -> int64

    init(cb (...int64) -> int64) {
        this.callback = cb
    }
}

func Main() {
    let cb (...int64) -> int64 = (xs) -> xs[0] + xs[1] + xs[2]
    let c = Container1823a(cb)
    Console.WriteLine(c.callback(1, 2, 3))
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NamedDelegateInvokeMemberCall_CoercesElementsToInt64_Runs() {
        let source = `package Probe1823b
import System

delegate LongSumDelegate1823(xs ...int64) int64;

func Main() {
    var s LongSumDelegate1823 = (xs) -> xs[0] + xs[1] + xs[2]
    Console.WriteLine(s.Invoke(1, 2, 3))
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_GenericStaticMethodFallbackWithSubstitution_CoercesElementsToInt64_Runs() {
        let source = `package Probe1823c
import System

class Utils1823c {
    shared {
        func First[T any](xs ...T) T {
            return xs[0]
        }
    }
}

func Main() {
    var a int32 = 1
    var b int32 = 2
    var c int32 = 3
    Console.WriteLine(Utils1823c.First[int64](a, b, c))
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1823_exe_").FullName
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

// <copyright file="Issue1630VariadicCoercionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1630 — the variadic (`...T`) call-site pack/pass-through
/// protocol was hand-duplicated across ~7 binder call paths, and two of them
/// had drifted to pack raw, uncoerced elements instead of applying the
/// issue-#1493 per-element implicit conversion. This left
/// `f(1, 2, 3)` through a `(...int64) -> int64` function-typed
/// variable, and through a named-delegate variable of the same shape,
/// packing `int32`-typed literals directly into an `int64[]`
/// slice — invalid IL (caught by ilverify) rather than the widened
/// `int64` elements every other variadic call path already produced.
/// Both facets below exercise the two previously-broken call shapes with
/// trailing elements that need an implicit numeric widening, and assert the
/// widened values are actually summed (not merely that the call compiles).
open class Issue1630VariadicCoercionEmitTests {
    @Fact
    func EndToEnd_FunctionTypedVariableIndirectCall_CoercesElementsToInt64_Runs() {
        let source = `package Probe1630a
import System

func Main() {
    let f (...int64) -> int64 = (xs) -> xs[0] + xs[1] + xs[2]
    Console.WriteLine(f(1, 2, 3))
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NamedDelegateDirectCall_CoercesElementsToInt64_Runs() {
        let source = `package Probe1630b
import System

delegate LongSumDelegate1630(xs ...int64) int64;

func Main() {
    var s LongSumDelegate1630 = (xs) -> xs[0] + xs[1] + xs[2]
    Console.WriteLine(s(1, 2, 3))
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1630_exe_").FullName
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

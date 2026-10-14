// <copyright file="Issue1439NullConditionalFieldInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1439 — the null-conditional delegate invocation shorthand
/// `field?(args)` on a nullable-delegate INSTANCE field. The receiver
/// load in `OverloadResolver.TryBindNullableDelegateInvocation` went
/// through `TryBuildImplicitMemberLoad`, which did not handle
/// `ImplicitFieldVariableSymbol` and fell back to a bare local load —
/// crashing emit with GS9998 "Variable '<field>' has no local slot".
/// The fix teaches `TryBuildImplicitMemberLoad` to load an instance
/// field as `this.field`, so every caller (and the explicit
/// `field?.Invoke(args)` form, which already worked) behaves the same.
open class Issue1439NullConditionalFieldInvokeEmitTests {
    @Fact
    func EndToEnd_NullConditionalInvokeOnNonNullField_Runs() {
        let source = `package Probe1439a
import System

open class Sink1439a {
    private let cb ((int32) -> void)?
    init(cb ((int32) -> void)?) { this.cb = cb }
    open func Fire(n int32) {
        cb?(n)
    }
}

func Main() {
    var total = 0
    let s = Sink1439a((n int32) -> { total = total + n })
    s.Fire(5)
    s.Fire(7)
    Console.WriteLine(total)
}`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullConditionalInvokeOnNilField_IsNoOp() {
        let source = `package Probe1439b
import System

open class Sink1439b {
    private let cb ((int32) -> void)?
    init(cb ((int32) -> void)?) { this.cb = cb }
    open func Fire(n int32) {
        cb?(n)
    }
}

func Main() {
    let s = Sink1439b(nil)
    s.Fire(5)
    Console.WriteLine("done")
}`
        let output = CompileAndRun(source)
        Assert.Equal("done${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullConditionalInvokeWithReturnValueField_Runs() {
        let source = `package Probe1439c
import System

open class Calc1439c {
    private let fn ((int32) -> int32)?
    init(fn ((int32) -> int32)?) { this.fn = fn }
    open func Apply(n int32) int32? {
        return fn?(n)
    }
}

func Main() {
    let c = Calc1439c((n int32) -> n * 2)
    Console.WriteLine(c.Apply(21) ?? -1)
    let none = Calc1439c(nil)
    Console.WriteLine(none.Apply(21) ?? -1)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1439_exe_").FullName
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

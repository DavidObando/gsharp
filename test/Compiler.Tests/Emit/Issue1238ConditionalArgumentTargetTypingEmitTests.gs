// <copyright file="Issue1238ConditionalArgumentTargetTypingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1238: end-to-end CLR emit coverage for target-typed conditional /
/// switch-expression CALL ARGUMENTS. An `if`/`else`, ternary, or
/// switch-expression passed directly as an argument must be target-typed to the
/// corresponding parameter type so a `nil` (or narrower) branch widens to
/// the parameter's nullable type — matching the behavior already present in
/// `return` / typed-`let` positions. The emitted program must run and
/// produce the expected values for both the nil and non-nil branches, and
/// ilverify must accept the assembly.
open class Issue1238ConditionalArgumentTargetTypingEmitTests {
    @Fact
    func EndToEnd_IfExpressionArgument_NilBranch_RunsCorrectly() {
        let source = `package Probe
import System

class C {
    func Describe(data string?) string {
        if data == nil {
            return "none"
        }
        return data!!
    }
    func Run(s string?) string {
        return Describe(if s == nil { nil } else { s!! })
    }
}

func Main() {
    var c = C()
    Console.WriteLine(c.Run(nil))
    Console.WriteLine(c.Run("hi"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("none${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_SwitchExpressionArgument_NilArm_RunsCorrectly() {
        let source = `package Probe
import System

class C {
    func Describe(data string?) string {
        if data == nil {
            return "none"
        }
        return data!!
    }
    func Run(n int32) string {
        return Describe(switch n { case 0: nil default: "val" })
    }
}

func Main() {
    var c = C()
    Console.WriteLine(c.Run(0))
    Console.WriteLine(c.Run(7))
}`
        let output = CompileAndRun(source)
        Assert.Equal("none${Environment.NewLine}val${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ConstructorArgument_IfExpressionNilBranch_RunsCorrectly() {
        let source = `package Probe
import System

class Holder {
    let value string?
    init(v string?) {
        this.value = v
    }
    func Text() string {
        if this.value == nil {
            return "empty"
        }
        return this.value!!
    }
}

class C {
    func Make(s string?) Holder {
        return Holder(if s == nil { nil } else { s!! })
    }
}

func Main() {
    var c = C()
    Console.WriteLine(c.Make(nil).Text())
    Console.WriteLine(c.Make("ok").Text())
}`
        let output = CompileAndRun(source)
        Assert.Equal("empty${Environment.NewLine}ok${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_cond1238_exe_").FullName
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

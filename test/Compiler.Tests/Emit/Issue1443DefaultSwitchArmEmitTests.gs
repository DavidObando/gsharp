// <copyright file="Issue1443DefaultSwitchArmEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1443 — a bare `default` used as a switch-expression arm result
/// (`case 0: default`) stayed an untyped `BoundDefaultExpression(Error)`
/// placeholder because arm results were bound without a target type. It then fell
/// into the conversion-failure branch and was silently replaced by a
/// `BoundErrorExpression`, crashing emission with GS9998. The fix re-binds the
/// bare-`default` arm against the switch's result type so it materialises as
/// `default(resultType)`, exactly like `default` in a return/arrow body.
open class Issue1443DefaultSwitchArmEmitTests {
    @Fact
    func EndToEnd_DefaultArmReturnsNullableUserClass_Runs() {
        let source = `package Probe1443a
import System

open class Thing1443a {
    prop Name string -> "thing"
}

func Pick(kind int32) Thing1443a? {
    return switch kind {
        case 0: default
        case 1: Thing1443a()
        default: throw InvalidOperationException("bad")
    }
}

func Main() {
    Console.WriteLine(Pick(0) == nil)
    Console.WriteLine(Pick(1) != nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DefaultArmReturnsValueTypeZero_Runs() {
        let source = `package Probe1443b
import System

func Score(kind int32) int32 {
    return switch kind {
        case 1: 10
        case 2: 20
        default: default
    }
}

func Main() {
    Console.WriteLine(Score(1))
    Console.WriteLine(Score(2))
    Console.WriteLine(Score(99))
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}20${Environment.NewLine}0${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1443_exe_").FullName
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

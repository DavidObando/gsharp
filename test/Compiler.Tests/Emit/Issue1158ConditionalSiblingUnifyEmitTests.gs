// <copyright file="Issue1158ConditionalSiblingUnifyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1158: end-to-end CLR emit coverage for unifying two sibling-subtype
/// arms of an `if`/conditional-expression to their shared base type. The
/// upcast must be a no-op reference conversion, so the value flowing out of the
/// conditional keeps its concrete runtime type per the branch taken.
open class Issue1158ConditionalSiblingUnifyEmitTests {
    @Fact
    func EndToEnd_IfExpression_SiblingArms_PreservesConcreteType() {
        let source = `package Probe
import System

open class Box { }
class Co64Box : Box { }
class StcoBox : Box { }

func PickIf(b bool) Box {
    let x = Co64Box()
    let y = StcoBox()
    return if b { x } else { y }
}

func Main() {
    Console.WriteLine(PickIf(true).GetType().Name)
    Console.WriteLine(PickIf(false).GetType().Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("Co64Box${Environment.NewLine}StcoBox${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Ternary_SiblingArms_PreservesConcreteType() {
        let source = `package Probe
import System

open class Box { }
class Co64Box : Box { }
class StcoBox : Box { }

func PickTern(b bool) Box {
    let x = Co64Box()
    let y = StcoBox()
    return b ? x : y
}

func Main() {
    Console.WriteLine(PickTern(true).GetType().Name)
    Console.WriteLine(PickTern(false).GetType().Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("Co64Box${Environment.NewLine}StcoBox${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_cond1158_exe_").FullName
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

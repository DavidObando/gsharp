// <copyright file="Issue1446PropertyIndexAssignEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1446 — writing to an array element through a bare instance
/// auto-property (`Prop[i] = v`) crashed emission with GS9998
/// "Variable 'Prop' has no local slot or parameter index in the current
/// method." The bare property name resolved to an
/// `ImplicitPropertyVariableSymbol`, which (unlike the implicit-field
/// case from #674) had no special handling in `BindIndexAssignmentExpression`
/// and fell through to a bare-variable load. The fix initialises a temp local
/// from the property getter (the array reference) and stores into that.
open class Issue1446PropertyIndexAssignEmitTests {
    @Fact
    func EndToEnd_InitArrayPropertyElementWriteInCtor_Runs() {
        let source = `package Probe1446a
import System

open class Holder1446a {
    init() {
        Items = [3]int32
        Items[0] = 10
        Items[1] = 20
        Items[2] = 30
    }
    prop Items []int32 { get; init; }
}

func Main() {
    let h = Holder1446a()
    Console.WriteLine(h.Items[0] + h.Items[1] + h.Items[2])
}`
        let output = CompileAndRun(source)
        Assert.Equal("60${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_MutableArrayPropertyElementWriteInMethod_Runs() {
        let source = `package Probe1446b
import System

open class Holder1446b {
    prop Data []string { get; set; }
    func Fill() {
        Data = [2]string
        Data[0] = "a"
        Data[1] = "b"
    }
}

func Main() {
    let h = Holder1446b()
    h.Fill()
    Console.WriteLine(h.Data[0] + h.Data[1])
}`
        let output = CompileAndRun(source)
        Assert.Equal("ab${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1446_exe_").FullName
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

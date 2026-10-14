// <copyright file="Issue1441StringFromCharArrayEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1441 — `string(charArray)` (the G# rendering of C#
/// `new string(char[])`) bound as a `[]char -> string` conversion
/// but had no emit path, crashing with GS9998
/// "Conversion from '[]char' to 'string' is not yet supported by the emitter".
/// The fix materialises it via the `System.String(char[])` constructor.
open class Issue1441StringFromCharArrayEmitTests {
    @Fact
    func EndToEnd_StringFromMutatedCharArray_Runs() {
        let source = `package Probe1441a
import System

func Conv(n int32) string {
    let nameBts = [n]char
    var i = 0
    while i < n {
        nameBts[i] = 'x'
        i = i + 1
    }
    return string(nameBts)
}

func Main() {
    Console.WriteLine(Conv(3))
}`
        let output = CompileAndRun(source)
        Assert.Equal("xxx${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_StringFromCharArrayParameter_Runs() {
        let source = `package Probe1441b
import System

func ToText(chars []char) string {
    return string(chars)
}

func Main() {
    let buf = [3]char
    buf[0] = 'h'
    buf[1] = 'i'
    buf[2] = '!'
    Console.WriteLine(ToText(buf))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hi!${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1441_exe_").FullName
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

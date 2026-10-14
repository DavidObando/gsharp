// <copyright file="Issue1407BclGenericMethodInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1407: BCL generic method inference must handle a by-ref array
/// parameter (`Array.Resize<T>(ref T[], int)`) and method type inference
/// from an arrow literal to a named delegate parameter
/// (`List<T>.ConvertAll<U>(Converter<T,U>)`).
open class Issue1407BclGenericMethodInferenceEmitTests {
    @Fact
    func ArrayResize_InfersElementTypeFromRefSlice_CompilesAndRuns() {
        let source = `package p
import System

var b = []uint8{0}
Array.Resize(&b, 5)
if b.Length != 5 { Environment.Exit(11) }
if b[0] != 0 { Environment.Exit(12) }
b[4] = 7
if b[4] != 7 { Environment.Exit(13) }`
        CompileVerifyAndRun(source)
    }

    @Fact
    func ListConvertAll_InfersResultTypeFromArrowToConverter_CompilesAndRuns() {
        let source = `package p
import System
import System.Collections.Generic
import System.Linq

let xs = []int32{1,2}.ToList()
let y = xs.ConvertAll((x int32)->x)
if y.Count != 2 { Environment.Exit(21) }
if y[0] != 1 { Environment.Exit(22) }
if y[1] != 2 { Environment.Exit(23) }`
        CompileVerifyAndRun(source)
    }

    shared {
        private func CompileVerifyAndRun(source string) {
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue1407_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let srcPath = Path.Combine(workDir, "test.gs")
                let outPath = Path.Combine(workDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                File.WriteAllText(Path.ChangeExtension(outPath, "runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch { }
            }
        }
    }
}

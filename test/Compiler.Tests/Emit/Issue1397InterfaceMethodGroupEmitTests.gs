// <copyright file="Issue1397InterfaceMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1397: a method accessed as a method group on an interface-typed
/// receiver must lower to a delegate over an interface dispatch so invoking it
/// reaches the concrete implementation. Emit must be verifiable and the
/// delegate must invoke through the interface (ldvirtftn), including for a
/// method inherited from a base interface.
open class Issue1397InterfaceMethodGroupEmitTests {
    @Fact
    func InterfaceMethodGroup_ToDelegate_DispatchesAndRuns() {
        let source = `package P
import System

interface IReader { func Run(x int32) int32; }
class Reader : IReader { func Run(x int32) int32 -> x * 10 }

func Use(r IReader) int32 {
    let d (int32) -> int32 = r.Run
    return d(5)
}

Console.WriteLine(Use(Reader()))`
        Assert.Equal("50${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InheritedInterfaceMethodGroup_ToDelegate_DispatchesAndRuns() {
        let source = `package P
import System

interface IBase { func Run(x int32) int32; }
interface IReader : IBase {}
class Reader : IReader { func Run(x int32) int32 -> x + 1 }

func Use(r IReader) int32 {
    let d (int32) -> int32 = r.Run
    return d(41)
}

Console.WriteLine(Use(Reader()))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1397_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) Static verification: the emitted IL must be valid.
                IlVerifier.Verify(outPath)
                // (b) Dynamic verification: the emitted code must execute.
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
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
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

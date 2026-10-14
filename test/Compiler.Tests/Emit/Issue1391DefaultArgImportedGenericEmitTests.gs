// <copyright file="Issue1391DefaultArgImportedGenericEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1391: passing the untyped `default` literal to an IMPORTED (CLR)
/// generic method invoked with an explicit type argument — e.g.
/// `Task.FromResult[int32](default)` — must compile AND lower the argument
/// to the proper default value of the SUBSTITUTED parameter type
/// (`default(int32)` = 0, `default(string)` = null,
/// `default(bool)` = false). Before the fix the call failed overload
/// resolution (GS0159); these tests round-trip gsc → PE → ilverify → dotnet exec
/// to prove a valid, correctly-typed default is emitted.
open class Issue1391DefaultArgImportedGenericEmitTests {
    @Fact
    func ImportedGenericDefault_PrimitiveTypeArg_ProducesZero() {
        let source = `package P
import System
import System.Threading.Tasks

func R() Task[int32] { return Task.FromResult[int32](default) }

var t = R()
Console.WriteLine(t.Result)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func ImportedGenericDefault_ReferenceTypeArg_ProducesNull() {
        let source = `package P
import System
import System.Threading.Tasks

func R() Task[string] { return Task.FromResult[string](default) }

var t = R()
Console.WriteLine(t.Result == nil)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func ImportedGenericDefault_BoolTypeArg_ProducesFalse() {
        let source = `package P
import System
import System.Threading.Tasks

func R() Task[bool] { return Task.FromResult[bool](default) }

var t = R()
Console.WriteLine(t.Result)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1391_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
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
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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

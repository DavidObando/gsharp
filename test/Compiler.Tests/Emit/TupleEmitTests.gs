// <copyright file="TupleEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Emit coverage for tuple.
open class TupleEmitTests {
    @Fact
    func TupleLiteral_Arity2_ItemAccess() {
        let source = `package P
import System

var t = (1, "hi")
Console.WriteLine(t.Item1)
Console.WriteLine(t.Item2)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func TupleLiteral_HeterogeneousArity3() {
        let source = `package P
import System

var t = (42, "answer", true)
Console.WriteLine(t.Item1)
Console.WriteLine(t.Item2)
Console.WriteLine(t.Item3)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}answer${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func TupleLiteral_Nested() {
        let source = `package P
import System

var t = (10, (20, 30))
Console.WriteLine(t.Item1)
Console.WriteLine(t.Item2.Item1)
Console.WriteLine(t.Item2.Item2)`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_tuple_emit_").FullName
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

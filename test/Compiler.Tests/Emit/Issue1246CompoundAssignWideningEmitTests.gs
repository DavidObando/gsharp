// <copyright file="Issue1246CompoundAssignWideningEmitTests.cs" company="GSharp">
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

/// Issue #1246: end-to-end execution of compound assignments whose right
/// operand widens into the LHS integer type (`int32 += uint8`,
/// `int64 += int32`, …). Before the fix these were rejected with GS0129
/// during binding; now the widening conversion is emitted before the operation
/// and the result is stored back into the LHS, producing the correct runtime
/// value — exactly like the equivalent `a = a + b`.
open class Issue1246CompoundAssignWideningEmitTests {
    @Fact
    func Int32PlusEqualsUInt8_StoresWidenedSum() {
        let source = `package P
import System

var a int32 = 200
var b uint8 = 100
a += b
Console.WriteLine(a)`
        Assert.Equal("300${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Int64AccumulatesInt32InLoop_StoresWidenedTotal() {
        let source = `package P
import System

var acc int64 = 0
var i int32 = 1
while i <= 5 {
    acc += i
    i = i + 1
}
Console.WriteLine(acc)`
        Assert.Equal("15${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Int64TimesEqualsInt32_StoresWidenedProduct() {
        let source = `package P
import System

var a int64 = 100000
var b int32 = 100000
a *= b
Console.WriteLine(a)`
        Assert.Equal("10000000000${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Int64PlusEqualsIntLiteral_StoresSum() {
        let source = `package P
import System

var x int64 = 2000000000
x += 2000000000
Console.WriteLine(x)`
        Assert.Equal("4000000000${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Int32MinusEqualsUInt8_StoresWidenedDifference() {
        let source = `package P
import System

var a int32 = 500
var b uint8 = 200
a -= b
Console.WriteLine(a)`
        Assert.Equal("300${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1246_").FullName
            try {
                return CompileAndRunImpl(source, tempDir)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunImpl(source string, tempDir string) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
        }
    }
}

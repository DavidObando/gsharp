// <copyright file="Issue1272ArrayAllocationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1272: end-to-end emit+run coverage for the native runtime/zero-init
/// array allocation form `[n]T`. The emitter lowers it to a CIL
/// `newarr`, which zero-initialises every element, yielding a `[]T`
/// slice of length `n`. These tests prove the produced slice has the
/// requested length, every element is the zero value, and that mutating and
/// reading the elements works.
open class Issue1272ArrayAllocationEmitTests {
    @Fact
    func RuntimeLength_ProducesZeroInitialisedSlice() {
        let source = `package P
import System

func make(n int32) []int32 {
    return [n]int32
}

let a = make(4)
Console.WriteLine(a.Length)
Console.WriteLine(a[0])
Console.WriteLine(a[1])
Console.WriteLine(a[2])
Console.WriteLine(a[3])`
        Assert.Equal(
            "4${Environment.NewLine}0${Environment.NewLine}0${Environment.NewLine}0${Environment.NewLine}0${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ConstantLength_ProducesZeroInitialisedSlice() {
        let source = `package P
import System

let a = [3]int32
Console.WriteLine(a.Length)
Console.WriteLine(a[0] + a[1] + a[2])`
        Assert.Equal("3${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RuntimeLength_MutateAndRead() {
        let source = `package P
import System

let n = 5
var a = [n]int32
a[0] = 10
a[4] = 20
Console.WriteLine(a.Length)
Console.WriteLine(a[0])
Console.WriteLine(a[4])
Console.WriteLine(a[2])`
        Assert.Equal(
            "5${Environment.NewLine}10${Environment.NewLine}20${Environment.NewLine}0${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func EmptyInitializerSpelling_ProducesZeroInitialisedSlice() {
        let source = `package P
import System

let n = 2
let a = [n]int32{}
Console.WriteLine(a.Length)
Console.WriteLine(a[0] + a[1])`
        Assert.Equal("2${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1272_emit_").FullName
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

// <copyright file="Issue664ClrArrayIndexerEmitTests.cs" company="GSharp">
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

/// End-to-end emit and execution tests for issue #664: CLR `T[]` arrays
/// (e.g. the result of `string.Split`) must be indexable with `arr[i]`
/// for both read and write, emitting correct `ldelem`/`stelem` opcodes.
open class Issue664ClrArrayIndexerEmitTests {
    @Fact
    func StringSplit_IndexZero_ReturnsFirstElement() {
        let source = `package P
import System

let parts = "a,b,c".Split(",")
Console.WriteLine(parts[0])`
        let output = CompileAndRun(source)
        Assert.Equal("a${Environment.NewLine}", output)
    }

    @Fact
    func StringArray_IndexAssignment_Works() {
        let source = `package P
import System

var parts = "a,b,c".Split(",")
parts[0] = "z"
Console.WriteLine(parts[0])`
        let output = CompileAndRun(source)
        Assert.Equal("z${Environment.NewLine}", output)
    }

    @Fact
    func IntArray_ReadIndex_Works() {
        let source = `package P
import System
import System.Linq

var arr = Enumerable.ToArray[int32](Enumerable.Range(10, 3))
Console.WriteLine(arr[1])`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}", output)
    }

    @Fact
    func IntArray_WriteIndex_Works() {
        let source = `package P
import System
import System.Linq

var arr = Enumerable.ToArray[int32](Enumerable.Range(0, 3))
arr[0] = 99
Console.WriteLine(arr[0])`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func ObjectArray_ReadIndex_Works() {
        let source = `package P
import System

let cmdArgs = Environment.GetCommandLineArgs()
let first = cmdArgs[0]
Console.WriteLine(first != "")`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func CharArray_ReadIndex_Works() {
        let source = `package P
import System

var ca = "hello".ToCharArray()
Console.WriteLine(int32(ca[0]))
Console.WriteLine(int32(ca[4]))`
        let output = CompileAndRun(source)
        Assert.Equal("104${Environment.NewLine}111${Environment.NewLine}", output)
    }

    @Fact
    func CharArray_WriteIndex_Works() {
        let source = `package P
import System

var ca = "hello".ToCharArray()
ca[0] = 'H'
Console.WriteLine(int32(ca[0]))`
        let output = CompileAndRun(source)
        Assert.Equal("72${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue664_").FullName
            try {
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
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

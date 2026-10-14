// <copyright file="MapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Emit coverage for map.
open class MapEmitTests {
    @Fact
    func MapLiteral_AndIndexRead() {
        let source = `package P
import System

var m = map[string,int32]{"a": 1, "b": 2}
Console.WriteLine(m["a"])
Console.WriteLine(m["b"])`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func MapIndex_MissingKey_ReturnsZeroValue() {
        let source = `package P
import System

var m = map[string,int32]{"a": 1}
Console.WriteLine(m["missing"])`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func MapIndexAssignment_AddAndUpdate() {
        let source = `package P
import System

var m = map[string,int32]{}
m["a"] = 1
m["b"] = 2
m["a"] = 99
Console.WriteLine(m["a"])
Console.WriteLine(m["b"])`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func Len_OnMap_ReturnsCount() {
        let source = `package P
import System

var m = map[string,int32]{"a": 1, "b": 2, "c": 3}
Console.WriteLine(m.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func Delete_RemovesKey_AndDecreasesLen() {
        let source = `package P
import System

var m = map[string,int32]{"a": 1, "b": 2}
m.Remove("a")
Console.WriteLine(m.Count)
Console.WriteLine(m["a"])
Console.WriteLine(m["b"])`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}0${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func EmptyMapLiteral_LenIsZero() {
        let source = `package P
import System

var m = map[int32,string]{}
Console.WriteLine(m.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func Map_IntKey_StringValue_RoundTrip() {
        let source = `package P
import System

var m = map[int32,string]{1: "one", 2: "two"}
Console.WriteLine(m[1])
Console.WriteLine(m[2])
Console.WriteLine(m[42])`
        let output = CompileAndRun(source)
        Assert.Equal("one${Environment.NewLine}two${Environment.NewLine}${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_map_emit_").FullName
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

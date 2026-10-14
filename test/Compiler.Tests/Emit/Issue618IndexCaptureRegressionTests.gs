// <copyright file="Issue618IndexCaptureRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #618 regression guard: verifies that closures capturing a variable
/// used only as the target of an index-assignment expression (array element
/// write, map key write, or CLR indexer write) compile correctly. Before
/// #618 the raw `VariableSymbol` target was invisible to both
/// `CapturedVariableCollector` and `BoxingRewriter`, causing
/// either a missing closure field (capture analysis gap) or a stale slot
/// reference (boxing rewrite gap).
open class Issue618IndexCaptureRegressionTests {
    /// Lambda captures a local array and writes an element via index
    /// assignment. The outer scope observes the mutation.
    @Fact
    func ArrayIndexWrite_FromClosure() {
        let source = `package Probe
import System

func Run() int32 {
    var arr = []int32{0, 0, 0}
    var writer = func(i int32, v int32) { arr[i] = v }
    writer(1, 42)
    return arr[1]
}

Console.WriteLine(Run())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    /// Lambda captures a local map and writes a key via index assignment.
    /// The outer scope observes the mutation.
    @Fact
    func MapIndexWrite_FromClosure() {
        let source = `package Probe
import System
import System.Collections.Generic

func Run() int32 {
    var m = map[string,int32]{}
    var put = func(k string, v int32) { m[k] = v }
    put("hello", 7)
    return m["hello"]
}

Console.WriteLine(Run())`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    /// Lambda captures a local Dictionary and writes a key via CLR indexer
    /// assignment. The outer scope observes the mutation.
    @Fact
    func ClrIndexerWrite_FromClosure() {
        let source = `package Probe
import System
import System.Collections.Generic

func Run() int32 {
    var d = Dictionary[string, int32]()
    var put = func(k string, v int32) { d[k] = v }
    put("x", 99)
    return d["x"]
}

Console.WriteLine(Run())`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    /// Lambda captures a local array inside a class method and writes
    /// an element. Confirms the fix works in the class-method path too.
    @Fact
    func ArrayIndexWrite_FromClosureInClassMethod() {
        let source = `package Probe
import System

class Probe {
    init() {}
    func Run() int32 {
        var arr = []int32{10, 20, 30}
        var writer = func(v int32) { arr[0] = v }
        writer(55)
        return arr[0]
    }
}

var p = Probe()
Console.WriteLine(p.Run())`
        let output = CompileAndRun(source)
        Assert.Equal("55${Environment.NewLine}", output)
    }

    /// Two lambdas share the same captured map and observe each other's
    /// writes through the shared box.
    @Fact
    func MultipleClosures_ShareCapturedMap() {
        let source = `package Probe
import System
import System.Collections.Generic

func Run() int32 {
    var m = map[string,int32]{}
    var put = func(k string, v int32) { m[k] = v }
    var get = func(k string) int32 { return m[k] }
    put("a", 1)
    put("b", 2)
    return get("a") + get("b")
}

Console.WriteLine(Run())`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_618_").FullName
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
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

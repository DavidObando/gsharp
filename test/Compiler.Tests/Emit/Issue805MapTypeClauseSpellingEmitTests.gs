// <copyright file="Issue805MapTypeClauseSpellingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #805 / ADR-0104 — end-to-end emit + ilverify coverage for the
/// canonical `map[K,V]` spelling. These tests are intentionally
/// minimal: the symbol-level emit path is unaffected by the
/// surface-syntax change, so what we are pinning down is that the
/// parser change has not broken IL emission or verifiability for the
/// canonical literal form across every type-clause slot the issue
/// names.
open class Issue805MapTypeClauseSpellingEmitTests {
    @Fact
    func CanonicalSpelling_InferredLocal_EmitsAndRuns() {
        let source = `package P
import System

var m = map[string,int32]{"a": 1}
Console.WriteLine(m["a"])`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func CanonicalSpelling_ExplicitTypedLocal_EmitsAndRuns() {
        let source = `package P
import System

var m map[string,int32] = map[string,int32]{"a": 1, "b": 2}
Console.WriteLine(m["a"])
Console.WriteLine(m["b"])`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func CanonicalSpelling_FunctionReturnType_EmitsAndRuns() {
        let source = `package P
import System

func makeIndex() map[string,int32] {
    return map[string,int32]{"a": 1, "b": 2}
}

var m = makeIndex()
Console.WriteLine(m["a"])
Console.WriteLine(m["b"])`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func CanonicalSpelling_FunctionParameterType_EmitsAndRuns() {
        let source = `package P
import System

func first(m map[string,int32]) int32 {
    return m["a"]
}

var m = map[string,int32]{"a": 42}
Console.WriteLine(first(m))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_map805_emit_").FullName
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

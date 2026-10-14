// <copyright file="Issue1188ExtensionOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1188: extension functions (ADR-0019) support overloading exactly like
/// ordinary class methods and free functions. Two extension functions that share
/// a (receiver type, name) pair but differ in parameter signature — by arity, by
/// parameter type, or by generic arity — must coexist and dispatch to the correct
/// overload through the standard overload-resolution machinery. Extensions whose
/// receiver types differ stay independent.
///
/// The defect was that the extension-function declaration table was keyed by
/// `(receiver type, name)` and rejected any second extension with the same
/// name and receiver, reporting `GS0102 '<name>' is already declared`.
///
/// These tests prove that overloaded extension calls compile, IL-verify, and
/// produce the correct runtime results.
open class Issue1188ExtensionOverloadEmitTests {
    @Fact
    func Extension_Overload_ByArity_ResolvesCorrectOverload() {
        let source = `package P
import System

func (s string) Do(x int32) string {
    return "one"
}

func (s string) Do(x int32, y int32) string {
    return "two"
}

Console.WriteLine("hi".Do(1))
Console.WriteLine("hi".Do(1, 2))`
        let output = CompileAndRun(source)
        Assert.Equal("one${Environment.NewLine}two${Environment.NewLine}", output)
    }

    @Fact
    func Extension_Overload_ByParameterType_ResolvesCorrectOverload() {
        let source = `package P
import System

func (s string) Tag(x int32) string {
    return "int"
}

func (s string) Tag(x string) string {
    return "str"
}

Console.WriteLine("hi".Tag(1))
Console.WriteLine("hi".Tag("x"))`
        let output = CompileAndRun(source)
        Assert.Equal("int${Environment.NewLine}str${Environment.NewLine}", output)
    }

    @Fact
    func Extension_Overload_GenericArityVariant_ResolvesCorrectOverload() {
        let source = `package P
import System

func (s string) Pick(x int32) string {
    return "concrete"
}

func (s string) Pick[T](item T) string {
    return "generic"
}

Console.WriteLine("hi".Pick(1))
Console.WriteLine("hi".Pick[string]("x"))`
        let output = CompileAndRun(source)
        Assert.Equal("concrete${Environment.NewLine}generic${Environment.NewLine}", output)
    }

    @Fact
    func Extension_Overload_DifferentReceiverTypes_StayIndependent() {
        let source = `package P
import System

func (s string) Kind(x int32) string {
    return "string-recv"
}

func (n int32) Kind(x int32) string {
    return "int-recv"
}

Console.WriteLine("hi".Kind(1))
Console.WriteLine((5).Kind(1))`
        let output = CompileAndRun(source)
        Assert.Equal("string-recv${Environment.NewLine}int-recv${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1188_emit_").FullName
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

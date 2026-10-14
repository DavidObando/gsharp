// <copyright file="Issue1335LambdaProtectedAccessTests.cs" company="GSharp">
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

/// Issue #1335 — a `protected`/`private` member of the enclosing class
/// referenced from inside a lambda / function-literal declared in the same class
/// must have the same access as the enclosing member (matching C#). Previously
/// the bind-time accessibility check lost the enclosing-type context inside a
/// closure body and wrongly reported `GS0379`. These tests pin the fix:
/// protected, private, field, property, and inherited-protected access all
/// compile and run from a closure (including nested closures), while genuine
/// inaccessibility (a protected member of an unrelated class) still reports
/// `GS0379`.
open class Issue1335LambdaProtectedAccessTests {
    @Fact
    func Lambda_CallsProtectedAndPrivateMember_Runs() {
        CompileVerifyAndRun(`package Maui.Issue1335.Tests

import System

open class C {
    protected func Prot() int32 {
        return 13
    }
    private func Priv() int32 {
        return 11
    }
    func F() int32 {
        let g = func () int32 { return Prot() + Priv() }
        return g()
    }
}

func Main() {
    let c = C{}
    Console.WriteLine(c.F())
}`, "24\n")
    }

    @Fact
    func Lambda_ReadsProtectedPropertyAndPrivateField_Runs() {
        CompileVerifyAndRun(`package Maui.Issue1335.Tests

import System

open class C {
    private var f int32
    protected prop P int32 { get { return 9 } }
    func F() int32 {
        f = 5
        let g = func () int32 { return f + P }
        return g()
    }
}

func Main() {
    let c = C{}
    Console.WriteLine(c.F())
}`, "14\n")
    }

    @Fact
    func Lambda_CallsInheritedProtectedMember_Runs() {
        CompileVerifyAndRun(`package Maui.Issue1335.Tests

import System

open class Base {
    protected func BaseHelper() int32 {
        return 7
    }
}

open class Derived : Base {
    func F() int32 {
        let g = func () int32 { return BaseHelper() }
        return g()
    }
}

func Main() {
    let d = Derived{}
    Console.WriteLine(d.F())
}`, "7\n")
    }

    @Fact
    func NestedLambda_CallsProtectedAndPrivateMember_Runs() {
        CompileVerifyAndRun(`package Maui.Issue1335.Tests

import System

open class C {
    protected func Prot() int32 {
        return 13
    }
    private func Priv() int32 {
        return 11
    }
    func F() int32 {
        let outer = func () int32 {
            let inner = func () int32 { return Prot() + Priv() }
            return inner()
        }
        return outer()
    }
}

func Main() {
    let c = C{}
    Console.WriteLine(c.F())
}`, "24\n")
    }

    @Fact
    func Lambda_AccessesUnrelatedClassProtectedMember_FailsToCompile() {
        let (exit, output) = TryCompile(`package Maui.Issue1335.Tests

import System

open class Other {
    protected func Secret() int32 {
        return 1
    }
}

class C {
    func F() int32 {
        let o = Other{}
        let g = func () int32 { return o.Secret() }
        return g()
    }
}

func Main() {
    let c = C{}
    Console.WriteLine(c.F())
}`)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0379", output)
    }

    shared {
        private func CompileVerifyAndRun(source string, expected string) {
            let dll = CompileToDll(source)
            try {
                IlVerifier.Verify(dll)
                let runtimeConfigPath = Path.ChangeExtension(dll, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + dll + "\""){
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
                Assert.Equal(expected, stdout.ReplaceLineEndings(Environment.NewLine))
            } finally {
                TryDeleteDir(Path.GetDirectoryName(dll))
            }
        }

        private func CompileToDll(source string) string {
            let (exit, output, outPath) = RunCompiler(source)
            Assert.True(exit == 0, "compile failed ($exit): $output")
            return outPath
        }

        private func TryCompile(source string)(Exit int32, Output string) {
            let (exit, output, outDir) = RunCompiler(source)
            TryDeleteDir(Path.GetDirectoryName(outDir))
            return (exit, output)
        }

        private func RunCompiler(source string)(Exit int32, Output string, OutPath string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1335_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, compileOut.ToString() + compileErr.ToString(), outPath)
        }

        private func TryDeleteDir(dir string?) {
            try {
                if dir != nil {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}

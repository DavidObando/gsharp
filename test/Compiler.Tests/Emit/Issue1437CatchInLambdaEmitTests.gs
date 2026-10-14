// <copyright file="Issue1437CatchInLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1437 — a body-introduced local (a `catch` clause variable, a
/// `switch` type-pattern binding, etc.) declared inside a `func`
/// literal / lambda body crashed emit with
/// `GS9998: InvalidOperationException: Variable '...' has no local slot or
/// parameter index in the current method.`.
///
/// Root cause: the binder's captured-variable analysis
/// (`CapturedVariableCollector`) only recorded `BoundVariableDeclaration`
/// targets as locals declared *within* the lambda. Catch / select-arm / range /
/// pattern variables were therefore misclassified as captures of an enclosing
/// scope. That false capture flowed into the lambda's
/// `CapturedVariables` set, and `CaptureBoxingRewriter` hoisted the
/// variable into a heap box — desynchronizing its declaration site (the
/// original symbol, for which the emit local-slot planner allocates a slot)
/// from its in-body reads (rewritten to `box.Value` against a fresh,
/// slot-less box local).
///
/// The fix records every body-introduced local from all such constructs as
/// declared, so it is symmetric with how top-level method bodies plan their
/// slots. These tests cover the generalization end-to-end (compile + run):
/// a catch variable used in a lambda, `throw ex` rethrow in a lambda
/// catch, a lambda that both captures an outer variable and has a try/catch,
/// a try/catch nested inside a `let`/`if` block in a lambda, and a
/// switch type-pattern variable in a lambda. Every package/user name is unique
/// so the process-wide `FunctionTypeSymbol` cache cannot alias across
/// in-process tests.
open class Issue1437CatchInLambdaEmitTests {
    @Fact
    func EndToEnd_CatchVariableUsedInLambda_Runs() {
        let source = `package Probe1437a
import System

func Main() {
    let f = func () {
        try {
            throw Exception("boom1437a")
        } catch (ex Exception) {
            Console.WriteLine("caught: " + ex.Message)
        }
    }
    f()
}`
        let output = CompileAndRun(source)
        Assert.Equal("caught: boom1437a${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_RethrowInLambdaCatch_Runs() {
        let source = `package Probe1437b
import System

func Main() {
    let f = func () {
        try {
            try {
                throw Exception("inner1437b")
            } catch (ex Exception) {
                throw ex
            }
        } catch (e Exception) {
            Console.WriteLine("outer caught: " + e.Message)
        }
    }
    f()
}`
        let output = CompileAndRun(source)
        Assert.Equal("outer caught: inner1437b${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_LambdaCapturesOuterVariableAndHasCatch_Runs() {
        let source = `package Probe1437c
import System

func Main() {
    let prefix = "P1437c:"
    let f = func () {
        try {
            throw Exception("z")
        } catch (ex Exception) {
            Console.WriteLine(prefix + ex.Message)
        }
    }
    f()
}`
        let output = CompileAndRun(source)
        Assert.Equal("P1437c:z${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_TryCatchNestedInsideLetBlockInLambda_Runs() {
        let source = `package Probe1437d
import System

func Main() {
    let f = func () {
        let outer = "O1437d:"
        if true {
            let inner = "I"
            try {
                throw Exception("q")
            } catch (ex Exception) {
                Console.WriteLine(outer + inner + ex.Message)
            }
        }
    }
    f()
}`
        let output = CompileAndRun(source)
        Assert.Equal("O1437d:Iq${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_TypePatternVariableInLambda_Runs() {
        let source = `package Probe1437e
import System

func Main() {
    let classify = func (o object) string {
        return switch o {
            case s is string: "str:" + s
            case n is int32: "int"
            default: "other"
        }
    }
    Console.WriteLine(classify("hi1437e"))
    Console.WriteLine(classify(5))
}`
        let output = CompileAndRun(source)
        Assert.Equal("str:hi1437e${Environment.NewLine}int${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullConditionalInvokeCaptureLocalInLambda_Runs() {
        // The `?(…)` operator introduces a synthetic `$ncap_N` capture local
        // referenced inside `WhenNotNull`. When the whole null-conditional sits
        // in a lambda body, that capture local must be treated as a body-local
        // declaration (not misclassified as a capture of an enclosing scope),
        // otherwise emit crashes with GS9998 "Variable '$ncap_N' has no local
        // slot". Here the nullable delegate is a captured parameter.
        let source = `package Probe1437f
import System

func Build1437f(cb ((int32) -> void)?) () -> void {
    return () -> {
        cb?(5)
    }
}

func Main() {
    var total = 0
    let run = Build1437f((n int32) -> { total = total + n })
    run()
    let noop = Build1437f(nil)
    noop()
    Console.WriteLine(total)
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1437_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
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

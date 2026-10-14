// <copyright file="Issue1453CapturedOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1453 — an inline `out var x` whose value is captured by a nested
/// lambda crashed emit with `GS9998: Variable 'x' has no local slot.`
///
/// Root cause: a captured local is hoisted into a per-variable `Box` class
/// by (cref:GSharp.Core.CodeAnalysis.Lowering.CaptureBoxingRewriter), but
/// the box local is only allocated (`var box = new Box()`) when the rewriter
/// visits the original's `BoundVariableDeclaration`. An inline `out var x`
/// produces <b>no declaration</b> — it binds straight to an address-of in the
/// call's `out` argument — so the box local was never declared, leaving it
/// without an IL slot.
///
/// The fix allocates the box for such declaration-less captured locals at the
/// statement that first introduces them (their address-of site), scoped to the
/// enclosing block. Block-level allocation means a loop body gets a fresh box
/// per iteration, matching how an ordinary `var x = e` inside a loop body
/// behaves — the closures below observe per-iteration values, not a shared one.
///
/// Each test compiles, IL-verifies (inside (cref:CompileAndRun)), and runs.
open class Issue1453CapturedOutVarEmitTests {
    @Fact
    func EndToEnd_TopLevelCapturedOutVar_VerifiesAndRuns() {
        // The headline repro: an inline `out var captured` read by a lambda.
        let source = `package Probe1453Top
import System

open class Q1453Top {
    func TryGet(out v int32) bool {
        v = 42
        return true
    }
}

func Main() {
    let q = Q1453Top()
    q.TryGet(out var captured)
    let f = func () int32 {
        return captured + 1
    }
    Console.WriteLine(f())
}`
        Assert.Equal("43${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_CapturedOutVarInLoopBody_GetsFreshBoxPerIteration() {
        // Each iteration's `out var c` must be a fresh box: the three captured
        // closures return 100, 101, 102 (sum 303), not a shared final 102 (306).
        let source = `package Probe1453Loop
import System
import System.Collections.Generic

open class Q1453Loop {
    func TryGet(out v int32) bool {
        v = 100
        return true
    }
}

func Main() {
    let q = Q1453Loop()
    var fns = List[(() -> int32)]()
    for i in 0 ... 3 {
        q.TryGet(out var c)
        c = c + i
        let f = func () int32 {
            return c
        }
        fns.Add(f)
    }
    var total = 0
    for g in fns {
        total = total + g()
    }
    Console.WriteLine(total)
}`
        Assert.Equal("303${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_MultipleCapturedOutVarsInOneCall_VerifiesAndRuns() {
        // Two inline out-vars introduced by a single call, both captured.
        let source = `package Probe1453Multi
import System

open class Q1453Multi {
    func TryTwo(out a int32, out b int32) bool {
        a = 7
        b = 9
        return true
    }
}

func Main() {
    let q = Q1453Multi()
    q.TryTwo(out var x, out var y)
    let f = func () int32 {
        return x + y
    }
    Console.WriteLine(f())
}`
        Assert.Equal("16${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_CapturedOutVarInLoopCondition_VerifiesAndRuns() {
        // An out-var introduced in a loop *condition* is attributed to the
        // enclosing block (one box), and its capture in the body is valid.
        let source = `package Probe1453Cond
import System

open class Q1453Cond {
    func TryGet(out v int32) bool {
        v = 100
        return true
    }
}

func Main() {
    let q = Q1453Cond()
    var sum = 0
    var count = 0
    for count < 2 && q.TryGet(out var w) {
        let f = func () int32 {
            return w
        }
        sum = sum + f()
        count = count + 1
    }
    Console.WriteLine(sum)
}`
        Assert.Equal("200${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_NonCapturedOutVar_StaysVerifiable() {
        // Control: an inline out-var that is *not* captured must keep its
        // ordinary local slot (the box rewriter never runs for it).
        let source = `package Probe1453Plain
import System

open class Q1453Plain {
    func TryGet(out v int32) bool {
        v = 42
        return true
    }
}

func Main() {
    let q = Q1453Plain()
    q.TryGet(out var captured)
    Console.WriteLine(captured)
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_OrdinaryCapturedLocalAndOutVarTogether_VerifiesAndRuns() {
        // Control: a normally-declared captured local (`var n = ...`) still
        // boxes at its declaration, and coexists with a captured out-var in
        // the same scope without double-allocating either box.
        let source = `package Probe1453Mixed
import System

open class Q1453Mixed {
    func TryGet(out v int32) bool {
        v = 40
        return true
    }
}

func Main() {
    let q = Q1453Mixed()
    var n = 2
    q.TryGet(out var captured)
    let f = func () int32 {
        return captured + n
    }
    Console.WriteLine(f())
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1453_exe_").FullName
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

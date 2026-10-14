// <copyright file="Issue1615ScopeProtectedRegionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1615 — a `return`, `break` or `goto` out of a
/// `scope { }` body emitted a bare `ret`/`br` from inside a
/// protected region: invalid per ECMA-335 (ReturnFromTry / BranchOutOfTry) and
/// an (cref:InvalidProgramException) at JIT time. The scope had its own
/// bespoke emitter, which used plain `EmitStatement` for the body and was
/// invisible to the lowerer's try-nesting count.
///
/// ADR-0174 D6 removed that shape entirely: the binder now lowers
/// `scope` into an ordinary try/catch/finally over a
/// `Gsharp.Concurrency.ScopeFrame`, so region-crossing exits get the same
/// `leave` and store-to-temp treatment as a hand-written `try`, by
/// construction rather than by a parallel code path. These tests stay as the
/// regression that says so.
open class Issue1615ScopeProtectedRegionEmitTests {
    @Fact
    func ReturnInsideScope_ReturnsValue_AndVerifies() {
        let source = `package Probe1615a

func f() int32 {
    scope {
        return 1
    }
}

func Main() {
    System.Console.WriteLine(f())
}`
        let output = CompileAndRun(source, "1615a")
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func BreakInsideScopeInsideLoop_BreaksLoop_AndVerifies() {
        let source = `package Probe1615b

func f() int32 {
    var i int32 = 0
    for i < 10 {
        scope {
            if i == 3 {
                break
            }
        }
        i = i + 1
    }
    return i
}

func Main() {
    System.Console.WriteLine(f())
}`
        let output = CompileAndRun(source, "1615b")
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func NestedScopeWithReturn_ReturnsValue_AndVerifies() {
        let source = `package Probe1615c

func f() int32 {
    scope {
        scope {
            return 42
        }
    }
}

func Main() {
    System.Console.WriteLine(f())
}`
        let output = CompileAndRun(source, "1615c")
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func ScopeInsideTry_ReturnFromScope_RunsFinally_AndVerifies() {
        let source = `package Probe1615d

func f() int32 {
    try {
        scope {
            return 7
        }
    } finally {
        System.Console.WriteLine("finally")
    }
}

func Main() {
    System.Console.WriteLine(f())
}`
        let output = CompileAndRun(source, "1615d")
        Assert.Equal("finally${Environment.NewLine}7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string, tag string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_${tag}_exe_").FullName
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

// <copyright file="Issue1451OutVarInLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1451 — an inline `out var x` declared *inside* a lambda / `func`
/// literal body crashed emit with GS9998 "Variable 'x' has no local slot or
/// parameter index in the current method." The out-var binds to
/// `BoundAddressOfExpression(BoundVariableExpression(local))` (not a
/// BoundVariableDeclaration), and loop lowering emits the loop body before the
/// declaring condition, so the lambda's capture analysis misclassified the
/// out-var as an enclosing-scope capture and boxed it, desynchronizing it from
/// its emit local slot. The fix pre-seeds the lambda capture collector with every
/// inline out-var declared in the body. The same out-var in a non-lambda function
/// always worked (the control).
open class Issue1451OutVarInLambdaEmitTests {
    @Fact
    func EndToEnd_OutVarInWhileConditionInsideLambda_Runs() {
        let source = `package Probe1451a
import System

open class Counter {
    private var n int32
    init() { this.n = 3 }
    func TryNext(out v int32) bool {
        if this.n <= 0 {
            v = 0
            return false
        }
        v = this.n
        this.n = this.n - 1
        return true
    }
}

func MakeSummer() (int32) -> int32 {
    let c = Counter()
    let sum = func (seed int32) int32 {
        var total = seed
        while c.TryNext(out var x) {
            total = total + x
        }
        return total
    }
    return sum
}

func Main() {
    let s = MakeSummer()
    Console.WriteLine(s(100))
}`
        let output = CompileAndRun(source)
        Assert.Equal("106${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_OutVarStraightLineInsideLambda_Runs() {
        let source = `package Probe1451b
import System

open class Box {
    func TryGet(out v int32) bool {
        v = 41
        return true
    }
}

func MakeReader() () -> int32 {
    let b = Box()
    let read = func () int32 {
        if b.TryGet(out var got) {
            return got + 1
        }
        return -1
    }
    return read
}

func Main() {
    let r = MakeReader()
    Console.WriteLine(r())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1451_exe_").FullName
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

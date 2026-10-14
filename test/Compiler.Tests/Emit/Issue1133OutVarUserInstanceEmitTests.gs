// <copyright file="Issue1133OutVarUserInstanceEmitTests.cs" company="GSharp">
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

/// Issue #1133: an inline `out var n` (and `out let n` / `out _`)
/// declaration at a <em>user instance method</em> call site was accepted but the
/// declared local never leaked into the enclosing block scope, so a later read
/// failed with `GS0125`. The free-function and imported-method paths already
/// re-bound the first-pass placeholder once overload resolution had chosen the
/// callee; `BindUserInstanceCall` did not. These tests compile, IL-verify,
/// and actually run the shape end-to-end so the leaked local both binds and
/// carries the right value at runtime.
open class Issue1133OutVarUserInstanceEmitTests {
    @Fact
    func ImplicitThis_OutVar_Compiles_And_Runs() {
        // The headline repro: `G(out var y)` on an implicit-`this` instance
        // method must declare `y` in the enclosing scope and return 5.
        let source = `package P
import System

class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out var y)
        return y
    }
}

var c = C()
Console.WriteLine(c.F())`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ExplicitReceiver_OutVar_Compiles_And_Runs() {
        // `c.G(out var y)` on an explicit receiver must leak `y` too.
        let source = `package P
import System

class C {
    func G(out x int32) { x = 7 }
}

class D {
    func F(c C) int32 {
        c.G(out var y)
        return y
    }
}

var c = C()
var d = D()
Console.WriteLine(d.F(c))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OutLet_ReadOnlyLocal_Compiles_And_Runs() {
        // `out let y` declares a read-only local; reading it is fine.
        let source = `package P
import System

class C {
    func G(out x int32) { x = 11 }
    func F() int32 {
        G(out let y)
        return y
    }
}

var c = C()
Console.WriteLine(c.F())`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OutDiscard_Compiles_And_Runs() {
        // `out _` discards the result; no name leaks into the enclosing scope.
        let source = `package P
import System

class C {
    func G(out x int32) { x = 5 }
    func F() int32 {
        G(out _)
        return 42
    }
}

var c = C()
Console.WriteLine(c.F())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericOutParameter_OutVar_Compiles_And_Runs() {
        // A generic out-parameter (`func M[T](seed T, out result T)`) must bind
        // the out-var local as the substituted pointee type (int32) and run.
        let source = `package P
import System

class C {
    func M[T](seed T, out result T) { result = seed }
    func F() int32 {
        M[int32](9, out var y)
        return y
    }
}

var c = C()
Console.WriteLine(c.F())`
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1133_emit_").FullName
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

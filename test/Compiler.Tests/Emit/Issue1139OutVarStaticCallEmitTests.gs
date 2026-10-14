// <copyright file="Issue1139OutVarStaticCallEmitTests.cs" company="GSharp">
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

/// Issue #1139 (follow-up to #1133): an inline `out var n` (and
/// `out let n` / `out _`) declaration at a <em>qualified static</em>
/// (`shared`) method call site (`C.G(out var y)`) was accepted but the
/// declared local never leaked into the enclosing block scope, so a later read
/// failed with `GS0125`. The instance path was fixed by #1137; the static
/// path (`BindUserTypeStaticCall`) never re-bound the first-pass
/// placeholder. These tests compile, IL-verify, and actually run the shape
/// end-to-end so the leaked local both binds and carries the right value at
/// runtime.
open class Issue1139OutVarStaticCallEmitTests {
    @Fact
    func QualifiedStatic_OutVar_Compiles_And_Runs() {
        // The headline repro: `C.G(out var y)` on a qualified static method must
        // declare `y` in the enclosing scope and return 5.
        let source = `package P
import System

class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out var y)
            return y
        }
    }
}

Console.WriteLine(C.F())`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func CrossTypeQualifiedStatic_OutVar_Compiles_And_Runs() {
        // `Other.G(out var y)` from a different type must leak `y` too.
        let source = `package P
import System

class Other {
    shared {
        func G(out x int32) { x = 7 }
    }
}

class C {
    shared {
        func F() int32 {
            Other.G(out var y)
            return y
        }
    }
}

Console.WriteLine(C.F())`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func QualifiedStatic_OutLet_ReadOnlyLocal_Compiles_And_Runs() {
        // `out let y` declares a read-only local; reading it is fine.
        let source = `package P
import System

class C {
    shared {
        func G(out x int32) { x = 11 }
        func F() int32 {
            C.G(out let y)
            return y
        }
    }
}

Console.WriteLine(C.F())`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func QualifiedStatic_OutDiscard_Compiles_And_Runs() {
        // `out _` discards the result; no name leaks into the enclosing scope.
        let source = `package P
import System

class C {
    shared {
        func G(out x int32) { x = 5 }
        func F() int32 {
            C.G(out _)
            return 42
        }
    }
}

Console.WriteLine(C.F())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericQualifiedStatic_OutVar_Compiles_And_Runs() {
        // A generic static out-parameter (`func M[T](seed T, out result T)`)
        // must bind the out-var local as the substituted pointee type (int32)
        // and run.
        let source = `package P
import System

class C {
    shared {
        func M[T](seed T, out result T) { result = seed }
        func F() int32 {
            C.M[int32](9, out var y)
            return y
        }
    }
}

Console.WriteLine(C.F())`
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1139_emit_").FullName
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

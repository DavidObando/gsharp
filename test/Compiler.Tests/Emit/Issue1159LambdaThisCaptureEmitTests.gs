// <copyright file="Issue1159LambdaThisCaptureEmitTests.cs" company="GSharp">
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

/// Issue #1159: a lambda body that makes an unqualified call to an
/// enclosing-instance method must capture `this` and dispatch through it
/// at runtime, producing the same value as an explicit `this.` call. These
/// end-to-end emit tests prove the captured receiver is actually used (not just
/// that the program compiles): the called instance method reads an instance
/// field, so a wrong/absent receiver would yield an incorrect value.
open class Issue1159LambdaThisCaptureEmitTests {
    @Fact
    func FuncLiteralLambda_CapturesThis_AndCallsInstanceMethod() {
        let source = `package P
import System

class C {
    var state int32 = 10
    func Bump(x int32) int32 { return x + state }
    func Run() {
        let g = func (d int32) int32 { return Bump(d) }
        Console.WriteLine(g(5))
    }
}

let c = C{ }
c.Run()`
        Assert.Equal("15${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ArrowLambda_CapturesThis_AndCallsInstanceMethod() {
        let source = `package P
import System

class C {
    var state int32 = 100
    func Bump(x int32) int32 { return x + state }
    func Run() {
        let g = (d int32) -> Bump(d)
        Console.WriteLine(g(7))
    }
}

let c = C{ }
c.Run()`
        Assert.Equal("107${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NestedLambda_CapturesThis_AndCallsInstanceMethod() {
        let source = `package P
import System

class C {
    var state int32 = 20
    func Bump(x int32) int32 { return x + state }
    func Run() {
        let g = func (d int32) int32 {
            let inner = func (e int32) int32 { return Bump(e) }
            return inner(d)
        }
        Console.WriteLine(g(3))
    }
}

let c = C{ }
c.Run()`
        Assert.Equal("23${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1159_emit_").FullName
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

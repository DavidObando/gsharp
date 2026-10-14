// <copyright file="Issue1051GenericArityTypesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1051: a type and a same-named generic of a different arity
/// (`Foo` and `Foo[T]`, mirroring `Task`/`Task<T>`)
/// coexist as distinct types keyed by (name, arity). The CLR mangles a generic
/// type's metadata name with the backtick-arity suffix (`Foo`1`) while the
/// arity-0 type keeps the bare name, so both emit to distinct TypeDefs and the
/// produced assembly is valid and runs.
open class Issue1051GenericArityTypesEmitTests {
    @Fact
    func Arity0AndArityNSameName_EmitsAndRuns() {
        let source = `package p
open class Box { func A() int32 { return 1 } }
open class Box[T] : Box { var V T }
func Main() {
    let a = Box()
    let b = Box[int32]{V: 5}
    System.Console.WriteLine(a.A() + b.V)
}`
        Assert.Equal("6${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func SameNamedInterfaceAndGenericInterface_EmitsAndRuns() {
        let source = `package p
import System

interface I { func Tag() int32; }
interface I[T] { func Wrap(v T) T; }

class C : I { func Tag() int32 { return 7 } }
class D[T] : I[T] { func Wrap(v T) T { return v } }

func Main() {
    let c = C{}
    let d = D[int32]{}
    Console.WriteLine(c.Tag() + d.Wrap(3))
}`
        Assert.Equal("10${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1051_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) Static verification: the emitted IL must be valid.
                IlVerifier.Verify(outPath)
                // (b) Dynamic verification: the emitted code must execute.
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

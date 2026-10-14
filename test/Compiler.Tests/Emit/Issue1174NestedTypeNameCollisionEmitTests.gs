// <copyright file="Issue1174NestedTypeNameCollisionEmitTests.cs" company="GSharp">
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

/// Issue #1174: a source-declared nested type whose simple name collides with a
/// same-named top-level type must remain referenceable via the qualified form
/// `Container.Nested` end-to-end — the constructed value's members resolve
/// against the NESTED type at runtime, including in a generic-argument position
/// (`List[C.E]`). Follow-up to #1080.
open class Issue1174NestedTypeNameCollisionEmitTests {
    @Fact
    func QualifiedNestedStructLiteral_UnderCollision_RunsAgainstNestedType() {
        let output = CompileAndRun(`package p

import System

class E { let Y int32 = 0 }

class C { data struct E(X uint32) { } }

func Main() {
    let e = C.E{X: 7u}
    Console.WriteLine(e.X)
}`)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func QualifiedNestedInGenericArgument_UnderCollision_RoundTrips() {
        let output = CompileAndRun(`package p

import System
import System.Collections.Generic

class E { let Y int32 = 0 }

class C { data struct E(X uint32) { } }

func Build() List[C.E] {
    let xs = List[C.E]()
    xs.Add(C.E{X: 5u})
    return xs
}

func Main() {
    let xs = Build()
    Console.WriteLine(xs[0].X)
}`)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func DeepQualifiedChain_WithOuterHomonym_RunsAgainstNestedType() {
        let output = CompileAndRun(`package p

import System

class C { data struct E(X uint32) { } }

class A { class B { data struct C(Z uint32) { } } }

func Main() {
    let v = A.B.C{Z: 9u}
    Console.WriteLine(v.Z)
}`)
        Assert.Equal("9${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1174_emit_").FullName
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
                Assert.True(compileExit == 0, (`compile failed (` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
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

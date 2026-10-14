// <copyright file="GenericTypeEmitTests.cs" company="GSharp">
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

/// Phase 4 emit-parity tests for generic user-defined types (Phase 4.3) —
/// emit commit F2: type-erased generic types.
///
/// Each open type parameter `T` is encoded as `System.Object` in
/// the type's field/primary-ctor signatures. Constructed instances
/// (`Box[int]`) share the definition's CLR TypeDef; value-type
/// substitutions cross the boundary via `box` at field initializers
/// and primary-ctor arguments, and `unbox.any` at field loads.
open class GenericTypeEmitTests {
    @Fact
    func GenericDataStruct_IntField_RoundTrips() {
        let source = `package P
import System

data struct Box[T any] {
    var Value T
}

let b = Box[int32]{Value: 42}
Console.WriteLine(b.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func GenericDataStruct_StringField_RoundTrips() {
        let source = `package P
import System

data struct Box[T any] {
    var Value T
}

let b = Box[string]{Value: "hi"}
Console.WriteLine(b.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func GenericClass_PrimaryCtor_IntField_RoundTrips() {
        let source = `package P
import System

class Box[T any](Value T) {
}

let b = Box[int32](7)
Console.WriteLine(b.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func GenericClass_PrimaryCtor_StringField_RoundTrips() {
        let source = `package P
import System

class Box[T any](Value T) {
}

let b = Box[string]("hello")
Console.WriteLine(b.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func GenericDataStruct_TwoParams_MixedValueAndReference() {
        let source = `package P
import System

data struct Pair[A any, B any] {
    var First A
    var Second B
}

let p = Pair[int32, string]{First: 3, Second: "x"}
Console.WriteLine(p.First)
Console.WriteLine(p.Second)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}x${Environment.NewLine}", output)
    }

    @Fact
    func GenericDataStruct_IntField_UsedInArithmetic() {
        // Round-trip proof: unbox.any after ldfld must produce a real int
        // so the JIT can fold it into the add.
        let source = `package P
import System

data struct Box[T any] {
    var Value T
}

let b = Box[int32]{Value: 20}
Console.WriteLine(b.Value + 22)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_generic_type_emit_").FullName
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

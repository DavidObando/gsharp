// <copyright file="Issue1214GenericExplicitInitCtorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1214: end-to-end emit tests proving a generic class that declares an
/// explicit `init(...)` constructor can be constructed at a closed type
/// (`Box[int32](5, "x")`). The explicit `.ctor` is emitted once on the
/// erased generic `TypeDef`; the construction call site references it
/// through a `MemberRef` parented at the construction's `TypeSpec`
/// ((cref:GSharp.CodeAnalysis.Emit.ReflectionMetadataEmitter)'s
/// `ResolveUserCtorTokenForExplicit`). Each test compiles via `gsc`,
/// runs `ilverify`, executes the produced assembly, and asserts that the
/// constructor actually ran (its argument round-trips through the instance) —
/// which can only hold when the ctor is correctly emitted and invoked.
open class Issue1214GenericExplicitInitCtorEmitTests {
    @Fact
    func GenericClass_ExplicitInitCtor_FieldsFromInitParams_RoundTrip() {
        let source = `package Probe
import System

class Box[T] {
    let value T
    var label string
    init(v T, l string) {
        value = v
        label = l
    }
    func Get() T { return value }
    func Label() string { return label }
}

let b = Box[int32](5, "x")
Console.WriteLine(b.Get())
Console.WriteLine(b.Label())`
        let output = CompileAndRun(source)
        // 5 proves the `value = v` field assignment in the constructor ran and
        // the int32 argument round-tripped through the `!0` slot; "x" proves the
        // second (string) init parameter was passed and stored correctly.
        Assert.Equal("5${Environment.NewLine}x${Environment.NewLine}", output)
    }

    @Fact
    func GenericClass_ExplicitInitCtor_TwoInstantiations_PerConstructionWorks() {
        let source = `package Probe
import System

class Box[T] {
    let value T
    init(v T) {
        value = v
    }
    func Get() T { return value }
}

let i = Box[int32](42)
let s = Box[string]("hello")
Console.WriteLine(i.Get())
Console.WriteLine(s.Get())`
        let output = CompileAndRun(source)
        // Two distinct closed constructions (Box[int32] and Box[string]) each
        // newobj the SAME erased .ctor through a per-construction TypeSpec
        // MemberRef; 42 and hello prove both arguments were passed and stored.
        Assert.Equal("42${Environment.NewLine}hello${Environment.NewLine}", output)
    }

    @Fact
    func GenericClass_ExplicitInitCtor_TypeParameterReturn_RoundTrip() {
        let source = `package Probe
import System

open class Mp4Operation[TOutput] {
    let label string
    init(name string) {
        label = name
    }
    func Name() string { return label }
}

func Make() Mp4Operation[int32] {
    return Mp4Operation[int32]("clip")
}

let op = Make()
Console.WriteLine(op.Name())`
        let output = CompileAndRun(source)
        Assert.Equal("clip${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1214_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
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
                } catch {
                    // ignored

                }
            }
        }
    }
}

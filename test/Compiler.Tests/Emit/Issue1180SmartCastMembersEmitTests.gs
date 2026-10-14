// <copyright file="Issue1180SmartCastMembersEmitTests.cs" company="GSharp">
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

/// Issue #1180 / ADR-0069 — Kotlin-style smart cast emit coverage for
/// stable member-access paths. Each test compiles via in-process
/// `gsc`, IL-verifies the emitted PE (so the inserted
/// `castclass`/`unbox.any` for narrowed member reads is
/// well-formed), and runs the assembly under `dotnet exec`,
/// asserting captured stdout.
open class Issue1180SmartCastMembersEmitTests {
    @Fact
    func SmartCast_StableInitOnlyProperty_NarrowsMemberReadInThenBranch() {
        let source = AnimalHierarchy + `class Box {
    prop Pet Animal { get; init; }
}

func Run(b Box) {
    if b.Pet is Dog {
        Console.WriteLine(b.Pet.Bark())
    } else {
        Console.WriteLine("not dog")
    }
}

Run(Box() { Pet = Dog{Name: "Rex"} })
Run(Box() { Pet = Cat{Name: "Whiskers"} })`
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}not dog${Environment.NewLine}", output)
    }

    @Fact
    func SmartCast_DeepStableChain_NarrowsNestedMemberRead() {
        let source = AnimalHierarchy + `class Inner {
    prop Pet Animal { get; init; }
}

class Outer {
    prop Box Inner { get; init; }
}

func Run(o Outer) {
    if o.Box.Pet is Dog {
        Console.WriteLine(o.Box.Pet.Bark())
    } else {
        Console.WriteLine("not dog")
    }
}

Run(Outer() { Box = Inner() { Pet = Dog{Name: "Rex"} } })
Run(Outer() { Box = Inner() { Pet = Cat{Name: "Whiskers"} } })`
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}not dog${Environment.NewLine}", output)
    }

    shared {
        private const AnimalHierarchy string = `package Test
import System

open class Animal {
    var Name string
    open func Describe() string { return Name }
}

class Dog : Animal {
    override func Describe() string { return Name + " (dog)" }
    func Bark() string { return Name + ":woof" }
}

class Cat : Animal {
    override func Describe() string { return Name + " (cat)" }
    func Purr() string { return Name + ":purr" }
}
`

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1180_").FullName
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
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
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
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
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

// <copyright file="Issue712FlowNarrowingExtensionsEmitTests.cs" company="GSharp">
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

/// Issue #712 / ADR-0069 addendum — flow-narrowing extensions across
/// `||` short-circuit (De Morgan dual of `&&`) and
/// `switch` arm discriminator narrowing (in-arm and post-switch).
/// Each test compiles via in-process `gsc`, IL-verifies the emitted
/// PE (so the inserted `castclass` for narrowed reads is well-
/// formed), and runs the assembly under `dotnet exec`.
open class Issue712FlowNarrowingExtensionsEmitTests {
    @Fact
    func Or_ElseBranch_OfNegatedIsTest_CallsDerivedMethod() {
        let source = AnimalHierarchy + `func Run(a Animal, flag bool) {
    if !(a is Dog) || flag {
        Console.WriteLine("skipped")
    } else {
        Console.WriteLine(a.Bark())
    }
}

Run(Dog{Name: "Rex"}, false)
Run(Dog{Name: "Rex"}, true)
Run(Cat{Name: "Whiskers"}, false)`
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}skipped${Environment.NewLine}skipped${Environment.NewLine}", output)
    }

    @Fact
    func Or_GuardStyle_BangIsTest_LiftsNarrowingAfterExit() {
        let source = AnimalHierarchy + `func Run(a Animal, force bool) {
    if a !is Dog || force {
        Console.WriteLine("skipped")
        return
    }

    Console.WriteLine(a.Bark())
    Console.WriteLine(a.Describe())
}

Run(Dog{Name: "Rex"}, false)
Run(Dog{Name: "Rex"}, true)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "Rex:woof${Environment.NewLine}Rex (dog)${Environment.NewLine}skipped${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Or_RightOperand_OfNegatedIsTest_BindsAtNarrowedType() {
        let source = AnimalHierarchy + `func Run(a Animal) bool {
    return !(a is Dog) || a.Bark() != ""
}

Console.WriteLine(Run(Dog{Name: "Rex"}))
Console.WriteLine(Run(Cat{Name: "Whiskers"}))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func Or_NilGuard_PostIfLift_NarrowsToNonNullable() {
        // ADR-0069 + issue #712: the guard-style early-exit composes through
        // `||` so the post-if region observes both `s != nil` AND `!force`.
        // (Originally this test had to use the post-if lift form because the
        // else-branch form tripped pre-existing if-else lowering bug #737;
        // that bug was fixed alongside this assertion, and the else-branch
        // companion lives in `Issue737NilGuardElseBranchEmitTests` to keep
        // each test scoped to one regression area.)
        let source = `package Test
import System

func Length(s string?, force bool) int32 {
    if s == nil || force {
        return -1
    }
    return s.Length
}

Console.WriteLine(Length("hello", false))
Console.WriteLine(Length("hello", true))
Console.WriteLine(Length(nil, false))`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func Switch_TypePattern_CallsDerivedMethodViaDiscriminator() {
        let source = AnimalHierarchy + `func Run(a Animal) {
    switch a {
        case d is Dog { Console.WriteLine(a.Bark()) }
        case c is Cat { Console.WriteLine(a.Purr()) }
        default { Console.WriteLine("other") }
    }
}

Run(Dog{Name: "Rex"})
Run(Cat{Name: "Whiskers"})`
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}Whiskers:purr${Environment.NewLine}", output)
    }

    @Fact
    func Switch_PostSwitch_LiftsCommonNarrowing() {
        let source = AnimalHierarchy + `func Run(a Animal) {
    switch a {
        case c is Cat {
            return
        }
        case d is Dog {
            Console.WriteLine("matched dog")
        }
        default {
            return
        }
    }
    Console.WriteLine(a.Bark())
}

Run(Dog{Name: "Rex"})
Run(Cat{Name: "Whiskers"})`
        let output = CompileAndRun(source)
        Assert.Equal("matched dog${Environment.NewLine}Rex:woof${Environment.NewLine}", output)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue712_").FullName
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

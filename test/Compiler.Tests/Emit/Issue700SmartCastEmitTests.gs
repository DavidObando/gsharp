// <copyright file="Issue700SmartCastEmitTests.cs" company="GSharp">
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

/// Issue #700 / ADR-0069 — Kotlin-style smart cast emit coverage. Each
/// test compiles via in-process `gsc`, IL-verifies the emitted PE
/// (so the inserted `castclass`/`unbox.any` for narrowed
/// reads is well-formed), and runs the assembly under `dotnet exec`,
/// asserting captured stdout.
open class Issue700SmartCastEmitTests {
    @Fact
    func SmartCast_If_IsTest_CallsDerivedMethodInThenBranch() {
        let source = AnimalHierarchy + `func Run(a Animal) {
    if a is Dog {
        Console.WriteLine(a.Bark())
    } else {
        Console.WriteLine("not dog")
    }
}

Run(Dog{Name: "Rex"})
Run(Cat{Name: "Whiskers"})`
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}not dog${Environment.NewLine}", output)
    }

    @Fact
    func SmartCast_If_NegatedIsTest_CallsDerivedMethodAfterEarlyExit() {
        let source = AnimalHierarchy + `func Run(a Animal) {
    if a !is Dog {
        Console.WriteLine("skipped")
        return
    }

    Console.WriteLine(a.Bark())
}

Run(Dog{Name: "Rex"})
Run(Cat{Name: "Whiskers"})`
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}skipped${Environment.NewLine}", output)
    }

    @Fact
    func SmartCast_If_AndChain_NarrowsRhsAndThenBranch() {
        let source = AnimalHierarchy + `func IsRex(d Dog) bool {
    return d.Name == "Rex"
}

func Run(a Animal) {
    if a is Dog && IsRex(a) {
        Console.WriteLine(a.Bark())
    } else {
        Console.WriteLine("no")
    }
}

Run(Dog{Name: "Rex"})
Run(Dog{Name: "Buddy"})
Run(Cat{Name: "Whiskers"})`
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}no${Environment.NewLine}no${Environment.NewLine}", output)
    }

    @Fact
    func SmartCast_If_NestedIsTest_NarrowsFurtherInsideInnerBlock() {
        let source = `package Test
import System

open class A {
    var Tag string
    open func Kind() string { return "A" }
}

open class B : A {
    override open func Kind() string { return "B" }
    func OnB() string { return Tag + ":B" }
}

class C : B {
    override func Kind() string { return "C" }
    func OnC() string { return Tag + ":C" }
}

func Run(a A) {
    if a is B {
        if a is C {
            Console.WriteLine(a.OnC())
        } else {
            Console.WriteLine(a.OnB())
        }
    }
}

Run(C{Tag: "x"})
Run(B{Tag: "y"})`
        let output = CompileAndRun(source)
        Assert.Equal("x:C${Environment.NewLine}y:B${Environment.NewLine}", output)
    }

    @Fact
    func SmartCast_If_EarlyExit_ThenIsTest_NarrowsAcrossStatements() {
        let source = AnimalHierarchy + (`func Run(a Animal) {
    if a !is Dog {
        Console.WriteLine("not a dog")
        return
    }

    // ` + "`" + `a` + "`" + ` is now ` + "`" + `Dog` + "`" + ` for the rest of the function. Both
    // statements should narrow the same parameter.
    Console.WriteLine(a.Bark())
    Console.WriteLine(a.Describe())
}

Run(Dog{Name: "Rex"})`)
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}Rex (dog)${Environment.NewLine}", output)
    }

    @Fact
    func SmartCast_If_IsTest_OnInterfaceReceiver_DispatchesAtNarrowedType() {
        // Narrowing from interface to a concrete implementation: after
        // `if a is Dog`, the call goes through `Dog`'s vtable rather
        // than through the interface dispatch.
        let source = `package Test
import System

interface Speaker {
    func Describe() string;
}

open class Animal {
    var Name string
    open func Describe() string { return Name }
}

class Dog : Animal {
    override func Describe() string { return Name + " (dog)" }
    func Bark() string { return Name + ":woof" }
}

func Run(s Animal) {
    if s is Dog {
        Console.WriteLine(s.Bark())
    }
}

Run(Dog{Name: "Rex"})`
        let output = CompileAndRun(source)
        Assert.Equal("Rex:woof${Environment.NewLine}", output)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue700_").FullName
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

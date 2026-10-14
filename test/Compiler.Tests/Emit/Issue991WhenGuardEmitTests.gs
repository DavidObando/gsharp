// <copyright file="Issue991WhenGuardEmitTests.cs" company="GSharp">
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

/// Issue #991 — `when` guards on switch arms. Each test compiles via the
/// in-process `gsc`, IL-verifies the emitted PE (so the inserted
/// guard branch is well-formed), and runs the assembly under
/// `dotnet exec`, asserting captured stdout.
open class Issue991WhenGuardEmitTests {
    @Fact
    func SwitchExpression_WhenGuard_ClassifySample() {
        let source = `package T
import System
func classify(n int32) string {
    return switch n {
        case > 0 when n < 10: "small"
        case > 0: "big"
        default: "nonpositive"
    }
}
Console.WriteLine(classify(5))
Console.WriteLine(classify(50))
Console.WriteLine(classify(-1))`
        let output = CompileAndRun(source)
        Assert.Equal("small${Environment.NewLine}big${Environment.NewLine}nonpositive${Environment.NewLine}", output)
    }

    @Fact
    func SwitchStatement_WhenGuard_ClassifySample() {
        let source = `package T
import System
func describe(n int32) {
    switch n {
    case > 0 when n < 10 { Console.WriteLine("small") }
    case > 0 { Console.WriteLine("big") }
    default { Console.WriteLine("nonpositive") }
    }
}
describe(5)
describe(50)
describe(-1)`
        let output = CompileAndRun(source)
        Assert.Equal("small${Environment.NewLine}big${Environment.NewLine}nonpositive${Environment.NewLine}", output)
    }

    @Fact
    func SwitchExpression_WhenGuard_WithTypePatternSmartCast() {
        // The guard observes the pattern-narrowed discriminant (`a` is `Dog`
        // inside the `is Dog` arm, so `a.Bark()` resolves to Dog's method).
        let source = `package T
import System

open class Animal {
    var Name string
    open func Describe() string { return Name }
}
class Dog : Animal {
    func Bark() string { return Name + ":woof" }
}
class Cat : Animal {
    func Purr() string { return Name + ":purr" }
}

func classify(a Animal) string {
    return switch a {
        case d is Dog when a.Bark() == "Rex:woof": "the famous Rex"
        case d is Dog: d.Bark()
        case c is Cat: c.Purr()
        default: a.Describe()
    }
}

Console.WriteLine(classify(Dog{Name: "Rex"}))
Console.WriteLine(classify(Dog{Name: "Buddy"}))
Console.WriteLine(classify(Cat{Name: "Whiskers"}))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "the famous Rex${Environment.NewLine}Buddy:woof${Environment.NewLine}Whiskers:purr${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue991_").FullName
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

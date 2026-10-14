// <copyright file="Issue992AndOrPatternEmitTests.cs" company="GSharp">
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

/// Issue #992 — `and` / `or` / `not` pattern combinators on switch arms. Each
/// test compiles via the in-process `gsc`, IL-verifies the emitted PE (so
/// the combinator branch wiring is well-formed), and runs the assembly under
/// `dotnet exec`, asserting captured stdout.
open class Issue992AndOrPatternEmitTests {
    @Fact
    func SwitchExpression_AndOr_ClassifySample() {
        let source = `package T
import System
func classify(n int32) string {
    return switch n {
        case > 0 and < 10: "small-positive"
        case < 0 or > 100: "extreme"
        default: "other"
    }
}
Console.WriteLine(classify(5))
Console.WriteLine(classify(-5))
Console.WriteLine(classify(200))
Console.WriteLine(classify(50))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "small-positive${Environment.NewLine}extreme${Environment.NewLine}extreme${Environment.NewLine}other${Environment.NewLine}",
            output
        )
    }

    @Fact
    func SwitchExpression_CombinatorPrecedence_AndBindsTighterThanOr() {
        // `== 0 or > 5 and < 10` parses as `(== 0) or ((> 5) and (< 10))`.
        let source = `package T
import System
func f(n int32) string {
    return switch n {
        case == 0 or > 5 and < 10: "A"
        default: "C"
    }
}
Console.WriteLine(f(0))
Console.WriteLine(f(7))
Console.WriteLine(f(3))
Console.WriteLine(f(100))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "A${Environment.NewLine}A${Environment.NewLine}C${Environment.NewLine}C${Environment.NewLine}",
            output
        )
    }

    @Fact
    func SwitchExpression_NotPattern_Negates() {
        let source = `package T
import System
func f(n int32) string {
    return switch n {
        case not > 0: "nonpositive"
        default: "positive"
    }
}
Console.WriteLine(f(-2))
Console.WriteLine(f(0))
Console.WriteLine(f(5))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "nonpositive${Environment.NewLine}nonpositive${Environment.NewLine}positive${Environment.NewLine}",
            output
        )
    }

    @Fact
    func SwitchExpression_ParenthesizedPattern_OverridesPrecedence() {
        // `(== 0 or == 1) and not == 0` matches exactly 1.
        let source = `package T
import System
func f(n int32) string {
    return switch n {
        case (== 0 or == 1) and not == 0: "one"
        default: "other"
    }
}
Console.WriteLine(f(0))
Console.WriteLine(f(1))
Console.WriteLine(f(2))`
        let output = CompileAndRun(source)
        Assert.Equal("other${Environment.NewLine}one${Environment.NewLine}other${Environment.NewLine}", output)
    }

    @Fact
    func SwitchExpression_TypePatternUnderAnd_SmartCastNarrows() {
        // Under `and`, the discriminant is narrowed by the type sub-pattern, so
        // `a.Bark()` resolves against the narrowed `Dog` type in the arm body.
        // The `{ Name: ... }` sub-pattern binds against the discriminant type
        // (Animal), which declares `Name`.
        let source = `package T
import System

open class Animal {
    var Name string
    open func Describe() string { return Name }
}
class Dog : Animal {
    func Bark() string { return Name + ":woof" }
}

func classify(a Animal) string {
    return switch a {
        case d is Dog and { Name: "Rex" }: a.Bark()
        case d is Dog: "other dog"
        default: a.Describe()
    }
}

Console.WriteLine(classify(Dog{Name: "Rex"}))
Console.WriteLine(classify(Dog{Name: "Buddy"}))
Console.WriteLine(classify(Animal{Name: "Generic"}))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "Rex:woof${Environment.NewLine}other dog${Environment.NewLine}Generic${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue992_").FullName
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

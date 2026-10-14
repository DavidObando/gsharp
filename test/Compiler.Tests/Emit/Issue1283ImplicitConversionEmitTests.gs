// <copyright file="Issue1283ImplicitConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Spectre.Console
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1283: a user-defined `func operator implicit (x T) U` declared
/// inside a struct/class body must be applied IMPLICITLY wherever a target type
/// is expected — at return, `let`/`var` init with an explicit type,
/// field/property store, and argument passing. Each site emits a
/// `call U op_Implicit(T)` around the source value, exactly like the
/// explicit type-call cast form `U(x)`. These tests compile a program that
/// exercises every position, verify the emitted IL, and assert the runtime
/// output proves the conversion ran.
open class Issue1283ImplicitConversionEmitTests {
    @Fact
    func ExactOahuCliTui_StyleNullableAndSemanticColorSites_CompileWithoutGS0155() {
        let semanticColor = `package Oahu.Cli.Tui.Tokens
import Spectre.Console

data struct SemanticColor(Value Color) {
    func operator implicit(c SemanticColor) Color {
        return c.Value
    }
    func operator implicit(c SemanticColor) Style {
        return Style(c.Value)
    }
}`
        let sites = `package Oahu.Cli.Tui.Widgets
import Spectre.Console
import Oahu.Cli.Tui.Tokens

class ConversionSites {
    var fill Style?

    func TakeNullable(fill Style?) {}
    func TakeStyle(fill Style) {}

    func ReturnNullable(fill Style) Style? {
        return fill
    }

    func PreserveNullable(fill Style?) Style? {
        let copy Style? = fill
        this.fill = fill
        this.TakeNullable(fill)
        return copy
    }

    func ReturnStyle(color SemanticColor) Style {
        return color
    }

    func Apply(fill Style, color SemanticColor) {
        let nullable Style? = fill
        this.fill = fill
        this.TakeNullable(fill)
        let style Style = color
        this.TakeStyle(color)
    }
}`
        let spectrePath = typeof(Style).Assembly.Location
        CompileAndVerify(
            []string{semanticColor, sites},
            []string{spectrePath, Path.Combine(Path.GetDirectoryName(spectrePath)!!, "Spectre.Console.Ansi.dll")}
        )
    }

    @Fact
    func InBodyImplicit_AppliedAtEveryTargetTypedPosition_EmitsAndRuns() {
        let source = `package P
import System

struct Meters {
    var V int32
    func operator implicit (v int32) Meters {
        return Meters{V: v}
    }
}

class C {
    var P Meters
    func Take(m Meters) {
        Console.WriteLine(m.V)
    }
    func Ret() Meters {
        return 5
    }
    func F(n int32) {
        let a Meters = n
        Console.WriteLine(a.V)
        var b Meters
        b = n
        Console.WriteLine(b.V)
        this.P = n
        Console.WriteLine(this.P.V)
        this.Take(n)
    }
}

let c = C{ }
Console.WriteLine(c.Ret().V)
c.F(7)`
        Assert.Equal(
            "5${Environment.NewLine}7${Environment.NewLine}7${Environment.NewLine}7${Environment.NewLine}7${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func InBodyImplicit_OnDataClass_AppliedAtAssignment_EmitsAndRuns() {
        let source = `package P
import System

data class Meters {
    var V int32
    func operator implicit (v int32) Meters {
        return Meters{V: v}
    }
}

let m Meters = 42
Console.WriteLine(m.V)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InBodyImplicit_FromVariableOperand_AppliedAtArgument_EmitsAndRuns() {
        let source = `package P
import System

struct Meters {
    var V int32
    func operator implicit (v int32) Meters {
        return Meters{V: v}
    }
}

func show(m Meters) {
    Console.WriteLine(m.V)
}

let n = 11
show(n)`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = CreateTestDirectory()
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

        private func CompileAndVerify(sources[]string, references[]string) {
            let workDir = CreateTestDirectory()
            try {
                let outPath = Path.Combine(workDir, "test.dll")
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                for reference in references {
                    args.Add("/reference:" + reference)
                }
                for var i = 0; i < sources.Length; i++ {
                    let sourcePath = Path.Combine(workDir, "source$i.gs")
                    File.WriteAllText(sourcePath, sources[i])
                    args.Add(sourcePath)
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                let diagnostics = compileOut.ToString() + compileErr.ToString()
                Assert.True(exitCode == 0, diagnostics)
                Assert.DoesNotContain("GS0155", diagnostics, StringComparison.Ordinal)
                IlVerifier.Verify(outPath, references)
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch { }
            }
        }

        private func CreateTestDirectory() string {
            let root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts")
            Directory.CreateDirectory(root)
            let path = Path.Combine(root, "gs_issue1283_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }
    }
}

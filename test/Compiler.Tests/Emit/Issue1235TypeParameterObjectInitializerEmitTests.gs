// <copyright file="Issue1235TypeParameterObjectInitializerEmitTests.cs" company="GSharp">
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

/// End-to-end emit tests for issue #1235 (write side / object-initializer
/// follow-up to `Issue988TypeParameterConstructionEmitTests`): a
/// composite literal `T{Member: value, ...}` on a type parameter `T`
/// constrained `where T : class, new()` — the generic counterpart of
/// C#'s `new T { Member = value }` object-initializer, and the plain
/// assignment form `t.Member = value` on a variable typed as a
/// constrained type parameter. This is the exact shape `cs2gs` emits for a
/// C# generic factory method such as
/// `Oahu.Core.BookLibrary.AddPersons<TPerson>`
/// (`where TPerson : class, IPerson, new()`) that does
/// `new TPerson { Asin = ..., Name = ... }`.
open class Issue1235TypeParameterObjectInitializerEmitTests {
    @Fact
    func ObjectInitializerLiteral_ClassConstraint_ConstructsAndAssignsProperty() {
        let source = `package T
import System
open class Base { prop P int32 { get; set; } }
func Make[T Base init()]() T { return T{P: 42} }
Console.WriteLine(Make[Base]().P.ToString())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ObjectInitializerLiteral_ClassConstraint_ConstructsAndAssignsField() {
        let source = `package T
import System
open class Base { var F int32 }
func Make[T Base init()]() T { return T{F: 7} }
Console.WriteLine(Make[Base]().F.ToString())`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ObjectInitializerLiteral_InterfaceConstraint_ConstructsAndAssignsProperty() {
        let source = `package T
import System
interface IHasName { prop Name string { get; set; } }
open class Named : IHasName { prop Name string { get; set; } }
func Make[T IHasName init()]() T { return T{Name: "Alice"} }
Console.WriteLine(Make[Named]().Name)`
        Assert.Equal("Alice${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func VariableReceiver_ClassConstraint_PropertyAssignment_Roundtrips() {
        // The plain-assignment counterpart of the object-initializer literal —
        // `var p T = T(); p.P = value` — the shape a translated
        // multi-statement C# object initializer lowers to.
        let source = `package T
import System
open class Base { prop P int32 { get; set; } }
func Make[T Base init()]() T {
    var p T = T()
    p.P = 99
    return p
}
Console.WriteLine(Make[Base]().P.ToString())`
        Assert.Equal("99${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func VariableReceiver_ClassConstraint_FieldAssignment_Roundtrips() {
        let source = `package T
import System
open class Base { var F int32 }
func Make[T Base init()]() T {
    var p T = T()
    p.F = 123
    return p
}
Console.WriteLine(Make[Base]().F.ToString())`
        Assert.Equal("123${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func VariableReceiver_InterfaceConstraint_PropertyAssignment_Roundtrips() {
        let source = `package T
import System
interface IHasName { prop Name string { get; set; } }
open class Named : IHasName { prop Name string { get; set; } }
func Make[T IHasName init()]() T {
    var p T = T()
    p.Name = "Carol"
    return p
}
Console.WriteLine(Make[Named]().Name)`
        Assert.Equal("Carol${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1235_run_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let (compileExit, compileText) = RunCompiler(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileText")
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
                TryDeleteDirectory(tempDir)
            }
        }

        private func RunCompiler(args[]string)(Exit int32, Output string) {
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
            return (compileExit, compileOut.ToString() + compileErr.ToString())
        }

        private func TryDeleteDirectory(dir string) {
            try {
                Directory.Delete(dir, recursive: true)
            } catch { }
        }
    }
}

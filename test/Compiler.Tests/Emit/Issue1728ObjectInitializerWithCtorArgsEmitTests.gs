// <copyright file="Issue1728ObjectInitializerWithCtorArgsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1728 — a G# construction combining constructor arguments with a
/// trailing property-initializer suffix (`Target(args) { Name = value }`,
/// gsc issue #522) must actually run and set BOTH the constructor-assigned
/// member AND every suffix-assigned member. This is the native G# form cs2gs
/// now emits for a C# `new Foo(x) { Bar = 2 }` (see
/// `Cs2Gs.Tests.Issue1728ObjectInitializerWithCtorArgsTranslationTests`
/// for the translator-fidelity side); this file proves the emitted form is
/// not just syntactically valid but semantically correct at runtime. Each
/// test uses a UNIQUE package/type name (Emit-suite convention).
open class Issue1728ObjectInitializerWithCtorArgsEmitTests {
    @Fact
    func CtorArgPlusSingleMemberInitializer_SetsBothMembers() {
        const source = `package i1728single
import System

class Foo {
    prop X int32 { get; init; }
    prop Bar int32 { get; set; }
    init(x int32) { X = x }
}

func Main() {
    let f = Foo(10) { Bar = 2 }
    System.Console.WriteLine(f.X)
    System.Console.WriteLine(f.Bar)
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func CtorArgPlusMultiMemberInitializer_SetsAllMembers() {
        const source = `package i1728multi
import System

class Foo {
    prop X int32 { get; init; }
    prop Bar int32 { get; set; }
    prop Baz string { get; set; }
    init(x int32) { X = x }
}

func Main() {
    let f = Foo(10) { Bar = 2, Baz = "hi" }
    System.Console.WriteLine(f.X)
    System.Console.WriteLine(f.Bar)
    System.Console.WriteLine(f.Baz)
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}2${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func CtorArgPlusMemberInitializer_UsedAsArgumentExpression_Runs() {
        // The construction-with-initializer-suffix form must compose at any
        // expression position, not just a `let`/`var` initializer.
        const source = `package i1728argpos
import System

class Foo {
    prop X int32 { get; init; }
    prop Bar int32 { get; set; }
    init(x int32) { X = x }
}

func Show(f Foo) { System.Console.WriteLine(f.X + f.Bar) }

func Main() { Show(Foo(10) { Bar = 2 }) }`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1728_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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
                } catch { }
            }
        }
    }
}

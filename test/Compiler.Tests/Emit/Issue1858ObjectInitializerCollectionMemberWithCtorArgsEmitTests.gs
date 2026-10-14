// <copyright file="Issue1858ObjectInitializerCollectionMemberWithCtorArgsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1858 — the construction-with-initializer-suffix form
/// (`Target(args) { Name = value, ... }`, gsc issue #522) now carries the
/// same target-less member collection-initializer carve-out already supported
/// by the colon struct-literal form (issue #1567): a braced member value
/// (`Items = { 1, 2 }`) populates a get-only collection member via
/// `Add(...)` calls, composing with constructor arguments AND ordinary
/// scalar members in the same construct. This closes the cs2gs-reported gap
/// where `new Foo(x) { Items = { a, b }, Bar = 2 }` had no canonical G#
/// form (see `Cs2Gs.Tests.Issue1858ObjectInitializerCtorArgsPlusCollectionMemberTranslationTests`
/// for the translator-fidelity side). This file proves the emitted form is
/// not just syntactically valid but semantically correct at runtime.
open class Issue1858ObjectInitializerCollectionMemberWithCtorArgsEmitTests {
    @Fact
    func CtorArgPlusCollectionMemberPlusScalarMember_PopulatesAll() {
        const source = `package i1858mixed
import System
import System.Collections.Generic

class Foo {
    prop X int32 { get; init; }
    prop Bar int32 { get; set; }
    prop Items IList[int32] { get; init; }
    init(x int32) {
        X = x
        Items = List[int32]()
    }
}

func Main() {
    let f = Foo(10) { Items = { 1, 2 }, Bar = 3 }
    System.Console.WriteLine(f.X)
    System.Console.WriteLine(f.Bar)
    System.Console.WriteLine(f.Items.Count)
    System.Console.WriteLine(f.Items[0])
    System.Console.WriteLine(f.Items[1])
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "10${Environment.NewLine}3${Environment.NewLine}2${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}",
            output
        )
    }

    @Fact
    func CtorArgPlusOnlyCollectionMember_PopulatesCollection() {
        const source = `package i1858onlycoll
import System
import System.Collections.Generic

class Foo {
    prop X int32 { get; init; }
    prop Items IList[int32] { get; init; }
    init(x int32) {
        X = x
        Items = List[int32]()
    }
}

func Main() {
    let f = Foo(7) { Items = { 42 } }
    System.Console.WriteLine(f.X)
    System.Console.WriteLine(f.Items.Count)
    System.Console.WriteLine(f.Items[0])
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}1${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func CtorArgPlusNestedObjectMember_PopulatesExistingObject() {
        const source = `package i1858nestedobject
import System

class Profile {
    prop Width int32 { get; set; }
    prop Height int32 { get; set; }
}

class Foo {
    prop X int32 { get; init; }
    prop Profile Profile { get; init; }
    init(x int32) {
        X = x
        Profile = Profile()
    }
}

func Main() {
    let f = Foo(7) { Profile = { Width = 80, Height = 30 } }
    System.Console.WriteLine(f.X)
    System.Console.WriteLine(f.Profile.Width)
    System.Console.WriteLine(f.Profile.Height)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}80${Environment.NewLine}30${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1858_exe_").FullName
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

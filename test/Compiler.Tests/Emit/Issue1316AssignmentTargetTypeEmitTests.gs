// <copyright file="Issue1316AssignmentTargetTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1316: end-to-end CLR emit coverage for an assignment whose RHS is a
/// target-typed conditional with a `nil` arm. A nullable property assigned
/// `if cond { nil } else { T(...) }` must thread the property's declared
/// type into the RHS binder so the `nil` arm unifies to `T?` (the same
/// adaptation a `let x T? = ...` initializer gets) and the assembly emits,
/// verifies, and runs — producing `nil` for the nil branch and a non-nil
/// value for the other branch.
open class Issue1316AssignmentTargetTypeEmitTests {
    @Fact
    func EndToEnd_NullablePropertyAssignment_BothBranches_RunCorrectly() {
        let source = `package Probe
import System

class AesCtr {
    init(k []uint8) {}
}

class C {
    init(key []uint8) {
        A = if key.Length == 0 { nil } else { AesCtr(key) }
    }
    prop A AesCtr? { get; init; }
}

func Main() {
    var empty []uint8 = []uint8{ }
    var filled []uint8 = []uint8{ 1, 2, 3 }
    var c1 = C(empty)
    var c2 = C(filled)
    Console.WriteLine(c1.A == nil)
    Console.WriteLine(c2.A == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableFieldAssignment_BothBranches_RunCorrectly() {
        let source = `package Probe
import System

class AesCtr {
    init(k []uint8) {}
}

class C {
    var f AesCtr?
    init(key []uint8) {
        f = if key.Length == 0 { nil } else { AesCtr(key) }
    }
    func IsNil() bool { return f == nil }
}

func Main() {
    var empty []uint8 = []uint8{ }
    var filled []uint8 = []uint8{ 1, 2, 3 }
    Console.WriteLine(C(empty).IsNil())
    Console.WriteLine(C(filled).IsNil())
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_assign1316_exe_").FullName
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

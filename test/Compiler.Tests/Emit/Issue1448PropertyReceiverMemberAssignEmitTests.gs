// <copyright file="Issue1448PropertyReceiverMemberAssignEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1448 — writing to a member through a bare instance-property receiver
/// (`Prop.Member = v`, `Prop.Member++`) crashed emission with GS9998
/// "Variable 'Prop' has no local slot or parameter index in the current
/// method." A bare property receiver resolved to an
/// `ImplicitPropertyVariableSymbol`, but `BindFieldAssignmentExpression`
/// synthesized an expression receiver only for the implicit-field case (#689).
/// The fix synthesizes `this.Prop` (a getter call) as the member-write
/// receiver, mirroring the implicit-field handling and the read-side fix #1339.
open class Issue1448PropertyReceiverMemberAssignEmitTests {
    @Fact
    func EndToEnd_MemberAssignAndIncrementThroughComputedProperty_Runs() {
        let source = `package Probe1448a
import System

open class Inner1448a {
    prop NextTrackID int32 { get; set; }
}

open class Outer1448a {
    private let innerField Inner1448a
    init() { innerField = Inner1448a() }
    prop Mvhd Inner1448a -> innerField

    func Bump() {
        Mvhd.NextTrackID = 5
        Mvhd.NextTrackID++
    }
}

func Main() {
    let o = Outer1448a()
    o.Bump()
    Console.WriteLine(o.Mvhd.NextTrackID)
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_MemberAssignThroughAutoProperty_Runs() {
        let source = `package Probe1448b
import System

open class Leaf1448b {
    prop Value string { get; set; }
}

open class Root1448b {
    init() { Child = Leaf1448b() }
    prop Child Leaf1448b { get; init; }

    func SetIt() {
        Child.Value = "hello"
    }
}

func Main() {
    let r = Root1448b()
    r.SetIt()
    Console.WriteLine(r.Child.Value)
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1448_exe_").FullName
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

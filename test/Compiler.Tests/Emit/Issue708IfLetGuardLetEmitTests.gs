// <copyright file="Issue708IfLetGuardLetEmitTests.cs" company="GSharp">
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

/// Issue #708 / ADR-0071 — emit coverage for `if let` /
/// `guard let` nullable-binding statements. Each test compiles via
/// in-process `gsc`, IL-verifies the emitted PE (so the synthesized
/// nil-checks and inner blocks are well-formed), and runs the assembly
/// under `dotnet exec`, asserting captured stdout.
open class Issue708IfLetGuardLetEmitTests {
    @Fact
    func IfLet_PrintsBindingWhenNonNil_NoElse() {
        let source = `package Test
import System

func Demo(s string?) {
    if let v = s {
        Console.WriteLine("got:" + v)
    }
}

Demo("hello")
Demo(nil)`
        Assert.Equal("got:hello${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLetElse_RunsThenBranchWhenNonNil_AndElseWhenNil() {
        let source = `package Test
import System

func Demo(s string?) {
    if let v = s {
        Console.WriteLine("got:" + v)
    } else {
        Console.WriteLine("nil")
    }
}

Demo("a")
Demo(nil)`
        Assert.Equal("got:a${Environment.NewLine}nil${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IfLet_MultipleBindings_AllOrNothing() {
        let source = `package Test
import System

func Demo(a string?, b string?) {
    if let x = a, let y = b {
        Console.WriteLine("both:" + x + "/" + y)
    } else {
        Console.WriteLine("missing")
    }
}

Demo("a", "b")
Demo("a", nil)
Demo(nil, "b")
Demo(nil, nil)`
        Assert.Equal(
            "both:a/b${Environment.NewLine}missing${Environment.NewLine}missing${Environment.NewLine}missing${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func GuardLet_ContinuesWhenNonNil_AndExitsViaElseWhenNil() {
        let source = `package Test
import System

func Demo(s string?) {
    guard let v = s else {
        Console.WriteLine("nil-exit")
        return
    }
    Console.WriteLine("ok:" + v)
}

Demo("hi")
Demo(nil)`
        Assert.Equal("ok:hi${Environment.NewLine}nil-exit${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GuardLet_MultipleBindings_FirstNilExits() {
        let source = `package Test
import System

func Demo(a string?, b string?) {
    guard let x = a, let y = b else {
        Console.WriteLine("exit")
        return
    }
    Console.WriteLine("both:" + x + "/" + y)
}

Demo("a", "b")
Demo("a", nil)
Demo(nil, "b")`
        Assert.Equal(
            "both:a/b${Environment.NewLine}exit${Environment.NewLine}exit${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func IfLet_NestedNarrowing_AllowsMemberAccess() {
        // Inside the then-branch, the narrowed `v` is usable as a plain
        // `string` (no further nil-guard needed for `.Length`).
        let source = `package Test
import System

func Demo(s string?) {
    if let v = s {
        Console.WriteLine(v.Length)
    }
}

Demo("abc")
Demo("xyzz")
Demo(nil)`
        Assert.Equal("3${Environment.NewLine}4${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue708_").FullName
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

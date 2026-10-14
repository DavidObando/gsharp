// <copyright file="Issue751RichReceiverEmitTests.cs" company="GSharp">
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

/// End-to-end emit + run coverage for issue #751 / ADR-0084 §L2: the
/// receiver clause now accepts rich type spellings (nullable, generic
/// application, tuple, nullable array, map[K,V]). Each test compiles a
/// G# program containing an extension method declaration whose receiver
/// previously rejected at parse time, IL-verifies the output, and
/// executes it under `dotnet exec` to prove the dispatched call
/// reaches the extension body.
open class Issue751RichReceiverEmitTests {
    @Fact
    func NullableString_Receiver_RoundTrips() {
        let source = `package P
import System

func (self string?) OrElse(fb string) string {
    return self ?? fb
}

var present string? = "hi"
var absent string? = nil
Console.WriteLine(present.OrElse("nope"))
Console.WriteLine(absent.OrElse("nope"))`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}nope${Environment.NewLine}", output)
    }

    @Fact
    func Tuple_Receiver_RoundTrips() {
        let source = `package P
import System

func (self (int32, string)) Show() string {
    return self.Item1.ToString() + ":" + self.Item2
}

var p = (42, "hi")
Console.WriteLine(p.Show())`
        let output = CompileAndRun(source)
        Assert.Equal("42:hi${Environment.NewLine}", output)
    }

    @Fact
    func NullableArray_Receiver_RoundTrips() {
        let source = `package P
import System

func (self []?int32) FirstOrZero() int32 {
    if self == nil {
        return 0
    }
    if self.Length == 0 {
        return 0
    }
    return self[0]
}

var present []?int32 = []int32{10, 20}
var absent []?int32 = nil
Console.WriteLine(present.FirstOrZero())
Console.WriteLine(absent.FirstOrZero())`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func Map_Receiver_RoundTrips() {
        let source = `package P
import System

func (self map[string,int32]) CountKeys() int32 {
    return self.Count
}

var m = map[string,int32]{"a": 1, "b": 2, "c": 3}
Console.WriteLine(m.CountKeys())`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue751_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
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
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                if !File.Exists(runtimeConfigPath) {
                    File.WriteAllText(runtimeConfigPath, `{
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
                psi.ArgumentList.Add(runtimeConfigPath)
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
                } catch {
                    // best effort

                }
            }
        }
    }
}

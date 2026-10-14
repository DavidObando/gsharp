// <copyright file="Issue2228DataClassWithEmitTests.cs" company="GSharp">
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

/// Issue #2228: a G# `data class` (the canonical target for a C# record class
/// whose data lives in body `init` auto-properties) must support the `with`
/// expression end-to-end — compile without GS0161, allocate a NEW instance
/// (reference semantics: the original instance is left unchanged), and
/// preserve value equality between two instances with identical members.
/// Mirrors the reported `OahuConfig`/`cfg = cfg with { DownloadDirectory = value }`
/// scenario: several primary-constructor fields, one overridden by `with`.
open class Issue2228DataClassWithEmitTests {
    @Fact
    func DataClass_With_CompilesAndUsesReferenceSemantics() {
        let source = (`package Probe
import System

data class OahuConfig(DownloadDirectory string, MaxParallelJobs int32, VerboseLogging bool) {
}

var cfg = OahuConfig("downloads", 1, false)
var updated = cfg with { DownloadDirectory = "elsewhere" }

// Reference semantics: the original instance is untouched.
Console.WriteLine(cfg.DownloadDirectory)
Console.WriteLine(cfg.MaxParallelJobs)
Console.WriteLine(cfg.VerboseLogging)

// The new instance has the overridden member and every other
// member copied from the original.
Console.WriteLine(updated.DownloadDirectory)
Console.WriteLine(updated.MaxParallelJobs)
Console.WriteLine(updated.VerboseLogging)

// ` + "`" + `cfg = cfg with { ... }` + "`" + ` (the exact reported call-site shape):
// assigning back is legal and observably updates the variable.
cfg = cfg with { DownloadDirectory = "elsewhere" }
Console.WriteLine(cfg.DownloadDirectory)

// Value equality: two data-class instances with identical
// members are equal even though they are distinct heap objects.
var other = OahuConfig("elsewhere", 1, false)
Console.WriteLine(cfg == other)
Console.WriteLine(cfg.Equals(other))
Console.WriteLine(cfg.GetHashCode() == other.GetHashCode())`)
        let output = CompileAndRun(source)
        Assert.Equal(
            "downloads${Environment.NewLine}1${Environment.NewLine}False${Environment.NewLine}elsewhere${Environment.NewLine}1${Environment.NewLine}False${Environment.NewLine}elsewhere${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func DataClass_With_FromAsyncStateMachine_CanCallSynthesizedConstructor() {
        let source = `package Probe
import System
import System.Threading.Tasks

data class Row(Name string) {
}

async func Copy(value Row) Row {
    await Task.Yield()
    return value with { Name = "after" }
}

Console.WriteLine(Copy(Row("before")).GetAwaiter().GetResult().Name)`
        Assert.Equal("after${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PlainClass_With_StillReportsGs0161() {
        let diagnostics = CompileExpectingErrors(`package Probe

class PlainConfig(DownloadDirectory string) {
}

var cfg = PlainConfig("downloads")
var updated = cfg with { DownloadDirectory = "elsewhere" }`)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0161", StringComparison.Ordinal))
        Assert.Contains(diagnostics, (d string) -> d.Contains("data class or data struct", StringComparison.Ordinal))
    }

    shared {
        // ====================================================================
        // Helpers
        // ====================================================================
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2228_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                Assert.True(compileExit == 0, (`gsc failed:
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2228_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                try {
                    Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                let combined = compileOut.ToString() + compileErr.ToString()
                return List[string](combined.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries))
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}

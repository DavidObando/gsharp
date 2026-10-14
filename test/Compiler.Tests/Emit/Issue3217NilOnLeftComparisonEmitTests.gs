// <copyright file="Issue3217NilOnLeftComparisonEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3217: a nil literal on the LEFT of `==` / `!=`
/// (`nil != x`) over a value-type `T?` previously fell through to
/// the emitter's generic `ceq` tail — the lifted-slot planner and the
/// nil-comparison emit arms only matched the nil-on-right shape — producing
/// unverifiable IL (InvalidProgramException at runtime). The binder now
/// canonicalizes the nil literal to the right; these tests run and ILVerify
/// both orders, in branch-condition and value positions, over value-type and
/// reference-type operands.
class Issue3217NilOnLeftComparisonEmitTests {
    @Fact
    func NilOnLeftComparisons_RunAndVerify() {
        const Source = `package Issue3217

import System

var x int32? = 7
var y int32 = 0
if nil != x {
    y = x
}
Console.WriteLine(y)

if nil == x {
    Console.WriteLine("nil")
} else {
    Console.WriteLine("some")
}

var n int32? = nil
if nil == n {
    Console.WriteLine("isnil")
}

Console.WriteLine(nil != x)
Console.WriteLine(nil == x)
Console.WriteLine(nil == n)

var s string? = "hi"
if nil != s {
    Console.WriteLine(s)
}`
        Assert.Equal(
            "7${Environment.NewLine}some${Environment.NewLine}isnil${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}hi${Environment.NewLine}",
            CompileVerifyAndRun(Source)
        )
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3217_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{
                            "/out:" + outputPath,
                            "/target:exe",
                            "/targetframework:net10.0",
                            "/nowarn:GS9100",
                            sourcePath
                        }
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$stdout$stderr")
                IlVerifier.Verify(outputPath)
                using let process = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                            outputPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                ) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let output = process.StandardOutput.ReadToEnd()
                let error = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, "exited ${process.ExitCode}:${Environment.NewLine}$error")
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }
    }
}

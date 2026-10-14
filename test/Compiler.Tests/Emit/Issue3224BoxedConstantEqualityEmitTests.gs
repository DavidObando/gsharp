// <copyright file="Issue3224BoxedConstantEqualityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3224: equality between an `object`-typed operand and a value
/// that boxes in (the Issue #1923 boxed-constant seam, `answer == 42`
/// where `answer` is typed `object`) uses ADR-0045 reference
/// equality. Each value operand boxes independently before the comparison.
class Issue3224BoxedConstantEqualityEmitTests {
    @Fact
    func BoxedConstantReferenceEquality_RunsAndVerifies() {
        const Source = `package Issue3224

import System

let answer object = 42
Console.WriteLine(answer == 42)
Console.WriteLine(answer != 42)
Console.WriteLine(answer == 41)
Console.WriteLine(answer != 41)

var n int32 = 42
Console.WriteLine(answer == n)

let text object = "hi"
Console.WriteLine(text == "hi")

if answer == 42 {
    Console.WriteLine("branch")
}`
        Assert.Equal(
            "False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileVerifyAndRun(Source)
        )
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3224_").FullName
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

// <copyright file="Issue2620VoidExpressionContextEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2620: discarded tail-if branches may produce `void`.
open class Issue2620VoidExpressionContextEmitTests {
    @Fact
    func ExactOahuTailIfLambda_VoidCalls_EmitsAndRuns() {
        let source = `package Oahu.Cli
import System

class CliEnvironment {
    shared {
        private func RunRestore() {
            Console.WriteLine("restore")
        }

        func InstallExitTrap() Action[bool] {
            return (first bool) -> {
                if first {
                    CliEnvironment.RunRestore()
                } else {
                    CliEnvironment.RunRestore()
                }
            }
        }
    }
}

let trap = CliEnvironment.InstallExitTrap()
trap(true)
trap(false)`
        Assert.Equal("restore${Environment.NewLine}restore${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func TailIfAsyncLambda_VoidAwaitAndCall_EmitAndRun() {
        let source = `package P
import System
import System.Threading.Tasks

async func Step(label string) {
    await Task.Yield()
    Console.WriteLine(label)
}

let handler = async (first bool) -> {
    if first {
        await Step("first")
    } else {
        Console.WriteLine("second")
    }
}

handler(true).GetAwaiter().GetResult()
handler(false).GetAwaiter().GetResult()`
        Assert.Equal("first${Environment.NewLine}second${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func TailIfVoidCalls_UsedAsValue_StillReportGS0124() {
        let diagnostics string? = CompileDiagnostics(`package P

func Restore() {
}

let result = if true { Restore() } else { Restore() }`)
        Assert.Equal(2, Count(diagnostics, "GS0124"))
    }

    @Fact
    func VoidAwait_UsedAsValue_StillReportsGS0124() {
        let diagnostics string? = CompileDiagnostics(`package P
import System.Threading.Tasks

async func Invalid() {
    let result = await Task.CompletedTask
}`)
        Assert.Equal(1, Count(diagnostics, "GS0124"))
    }

    shared {
        private func Count(text string?, value string) int32 {
            var count = 0
            var start = 0
            while (start = text!!.IndexOf(value, start, StringComparison.Ordinal)) >= 0 {
                count++
                start += value.Length
            }
            return count
        }

        private func CompileDiagnostics(source string) string? {
            var diagnostics string? = nil
            WithCompilation(
                source,
                (exitCode int32, output string, _ string) -> {
                    Assert.NotEqual(0, exitCode)
                    diagnostics = output
                }
            )
            return diagnostics
        }

        private func CompileAndRun(source string) string? {
            var output string? = nil
            WithCompilation(
                source,
                (exitCode int32, diagnostics string, outputPath string) -> {
                    Assert.True(exitCode == 0, "compile failed ($exitCode): $diagnostics")
                    IlVerifier.Verify(outputPath)
                    let runtimeConfigPath = Path.ChangeExtension(outputPath, "runtimeconfig.json")
                    File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                    let psi = ProcessStartInfo("dotnet", "exec \"" + outputPath + "\""){
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                    using let process = Process.Start(psi)!!
                    output = process.StandardOutput.ReadToEnd()
                    let stderr = process.StandardError.ReadToEnd()
                    process.WaitForExit()
                    Assert.True(process.ExitCode == 0, "exited ${process.ExitCode}: $stderr")
                }
            )
            return output?.ReplaceLineEndings(Environment.NewLine)
        }

        private func WithCompilation(source string, verify(int32, string, string) -> void) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2620_").FullName
            try {
                let sourcePath = Path.Combine(tempDir, "test.gs")
                let outputPath = Path.Combine(tempDir, "test.dll")
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
                verify(exitCode, stdout.ToString() + stderr.ToString(), outputPath)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

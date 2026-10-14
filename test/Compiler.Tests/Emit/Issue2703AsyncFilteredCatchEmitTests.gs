// <copyright file="Issue2703AsyncFilteredCatchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2703: smart-cast exception types must survive async state-machine
/// hoisting in the two filtered-catch shapes emitted for Oahu.Cli.App.
open class Issue2703AsyncFilteredCatchEmitTests {
    @Fact
    func ExactRunOneAsyncFilteredCatch_VerifiesAndRuns() {
        const Source = `package Oahu.Cli.App.Jobs

import System
import System.Threading.Tasks

async func RunOneAsync(canceled bool) string {
    try {
        await Task.Yield()
        if canceled {
            throw OperationCanceledException("canceled")
        }
        throw InvalidOperationException("failed")
    } catch (__caught Exception) {
        if __caught is OperationCanceledException {
            let __caught = __caught
            await Task.Yield()
            return "cancel:" + __caught.Message
        } else {
            if __caught is Exception {
                let ex = __caught
                await Task.Yield()
                return "error:" + ex.Message
            } else {
                throw __caught
            }
        }
    }
}

Console.WriteLine(RunOneAsync(true).GetAwaiter().GetResult())
Console.WriteLine(RunOneAsync(false).GetAwaiter().GetResult())`
        Assert.Equal(
            "cancel:canceled${Environment.NewLine}error:failed${Environment.NewLine}",
            CompileVerifyAndRun(Source, "RunOneAsync")
        )
    }

    @Fact
    func ExactCheckAudibleApiReachableAsyncFilteredCatch_VerifiesAndRuns() {
        const Source = `package Oahu.Cli.App.Doctor

import System
import System.Threading.Tasks

async func CheckAudibleApiReachableAsync(canceled bool) string {
    try {
        await Task.Yield()
        if canceled {
            throw OperationCanceledException("timed out")
        }
        throw InvalidOperationException("offline")
    } catch (__caught Exception) {
        if __caught is OperationCanceledException {
            let __caught = __caught
            if canceled {
                return "timeout:" + __caught.Message
            } else {
                if __caught is Exception {
                    let ex = __caught
                    return "error:" + ex.Message
                } else {
                    throw __caught
                }
            }
        } else {
            if __caught is Exception {
                let ex = __caught
                return "error:" + ex.Message
            } else {
                throw __caught
            }
        }
    }
}

Console.WriteLine(CheckAudibleApiReachableAsync(true).GetAwaiter().GetResult())
Console.WriteLine(CheckAudibleApiReachableAsync(false).GetAwaiter().GetResult())`
        Assert.Equal(
            "timeout:timed out${Environment.NewLine}error:offline${Environment.NewLine}",
            CompileVerifyAndRun(Source, "CheckAudibleApiReachableAsync")
        )
    }

    @Fact
    func AsyncExceptionDowncast_OutsideTypeGuard_RemainsRejected() {
        let syntax = SyntaxTree.Parse(SourceText.From(`package Issue2703Negative

import System
import System.Threading.Tasks

async func Invalid(ex Exception) {
    if ex is OperationCanceledException {
        Console.WriteLine(ex.CancellationToken)
    }
    await Task.Yield()
    Console.WriteLine(ex.CancellationToken)
}`))
        let compilation = Compilation(syntax)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2703.Negative")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    shared {
        private func CompileVerifyAndRun(source string, caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2703Emit", caseName)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            IlVerifier.Verify(outputPath)
            using let process Process? = Process.Start(
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
            )
            let output = process!!.StandardOutput.ReadToEnd()
            let error = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process!!.ExitCode == 0, error)
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}

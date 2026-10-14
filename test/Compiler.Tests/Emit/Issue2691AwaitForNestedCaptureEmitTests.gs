// <copyright file="Issue2691AwaitForNestedCaptureEmitTests.cs" company="GSharp">
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

/// Issue #2691: an await-for iteration variable captured by a nested lambda
/// inside an async lambda had neither closure storage nor a MoveNext slot.
open class Issue2691AwaitForNestedCaptureEmitTests {
    @Fact
    func OahuHistoryDelete_AsyncLambdaAwaitForNestedAny_RunsAndVerifies() {
        const Source = `package Oahu.Cli.Commands
import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks

class JobRecord(asin string) {
    prop Asin string -> asin
}

async func ReadAllAsync() IAsyncEnumerable[JobRecord] {
    yield JobRecord("B")
    await Task.Yield()
    yield JobRecord("A")
}

let action = async () -> {
    let asins = []string{ "A" }
    var matches = 0
    await for rec in ReadAllAsync() {
        let matchesAsin = asins.Any((a string) -> String.Equals(a, rec.Asin, StringComparison.OrdinalIgnoreCase))
        if matchesAsin {
            matches += 1
        }
    }
    return matches
}

Console.WriteLine(action().GetAwaiter().GetResult())`
        Assert.Equal("1${Environment.NewLine}", CompileVerifyAndRun(Source, "Oahu"))
    }

    @Fact
    func AwaitFor_EscapingClosures_GetFreshHoistedSlotPerIteration() {
        const Source = `package AwaitForCapture
import System
import System.Collections.Generic
import System.Threading.Tasks

class JobRecord(asin string) {
    prop Asin string -> asin
}

async func ReadAllAsync() IAsyncEnumerable[JobRecord] {
    yield JobRecord("B")
    await Task.Yield()
    yield JobRecord("A")
}

async func Run() {
    var readers = List[(() -> string)]()
    await for rec in ReadAllAsync() {
        readers.Add(() -> rec.Asin)
    }
    Console.WriteLine(readers[0]() + readers[1]())
}

Run().GetAwaiter().GetResult()`
        Assert.Equal("BA${Environment.NewLine}", CompileVerifyAndRun(Source, "Escaping"))
    }

    @Fact
    func AwaitFor_VariableOutsideLoop_RemainsRejected() {
        let syntax = SyntaxTree.Parse(SourceText.From(`package AwaitForCaptureNegative
import System.Collections.Generic

class JobRecord {}

async func ReadAllAsync() IAsyncEnumerable[JobRecord] {
    yield JobRecord()
}

async func Run() {
    await for rec in ReadAllAsync() {}
    let invalid = () -> rec
}`))
        let compilation = Compilation(syntax)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2691.Negative")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0125")
    }

    shared {
        private func CompileVerifyAndRun(source string, caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2691Emit", caseName)
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

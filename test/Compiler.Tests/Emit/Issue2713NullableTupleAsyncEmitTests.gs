// <copyright file="Issue2713NullableTupleAsyncEmitTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #2713: async functions returning a tuple with a nullable-reference
/// element must remain Task-wrapped at call sites.
class Issue2713NullableTupleAsyncEmitTests {
    @Fact
    func ExactOahuCoreNullableTupleAwait_DiagnosticsDropFromSevenToZero() {
        const source = `package Oahu.Core

import System
import System.Threading.Tasks

async func ReadAsync() (string?, int32) {
    await Task.Yield()
    return ("oahu", 7)
}

async func RunAsync() int32 {
    let (text, value) = await ReadAsync()
    let first = text
    let second = value
    let third = text
    Console.WriteLine(text!!)
    return value
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        let errors = compilation.BoundProgram.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError).ToArray()
        Assert.True(
            errors.Length == 0,
            "The exact Oahu.Core regression must drop from 7 diagnostics to 0:${Environment.NewLine}" + string.Join(
                Environment.NewLine,
                errors.Select((diagnostic Diagnostic) -> diagnostic.ToString())
            )
        )
    }

    @Fact
    func MinimalNullableTupleAsyncAwait_VerifiesAndRuns() {
        const source = `package Issue2713

import System
import System.Threading.Tasks

async func ReadAsync() (string?, int32) {
    await Task.Yield()
    return ("ok", 7)
}

async func RunAsync() int32 {
    let (text, value) = await ReadAsync()
    Console.WriteLine(text!!)
    return value
}

Console.WriteLine(RunAsync().GetAwaiter().GetResult())`
        Assert.Equal("ok${Environment.NewLine}7${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    @Fact
    func NonAsyncNullableTuple_RemainsNonAwaitable() {
        const source = `package Issue2713Negative

func Read() (string?, int32) {
    return ("no task", 7)
}

async func Run() int32 {
    let (text, value) = await Read()
    return value
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        let diagnostics = compilation.BoundProgram.Diagnostics
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0133")
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2713Emit")
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
                Assert.True(exitCode == 0, "compile failed ($exitCode):${Environment.NewLine}$stdout$stderr")
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

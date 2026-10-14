// <copyright file="Issue2854TopLevelEllipsisLoopCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2854: top-level numeric ellipsis loop captures compile and run.
/// Asserts the emitted program against pinned golden values; the interpreter
/// parity arm was retired with the evaluator in ADR-0156 Phase 3c (#3176).
open class Issue2854TopLevelEllipsisLoopCaptureTests {
    @Fact
    func TopLevelClosureCapturesIterationVariable() {
        const Source = `package Issue2854
import System

var callback = () -> { return -1 }

for i in 0 ... 1 {
    callback = () -> { return i }
}

let result = callback()
Console.WriteLine(result)
result`
        AssertEmittedResult(Source, expected: 0, "TopLevelClosureCapturesIterationVariable")
    }

    @Fact
    func TopLevelForInCapturedWriteUsesSharedCell() {
        const Source = `package Issue2854ForIn
import System

var source = []int32{7, 8}
var total = 0
for value in source {
    var bump = () -> { value = value + 100 }
    bump()
    total = total + value
}

let result = total
Console.WriteLine(result)
result`
        AssertEmittedResult(Source, expected: 215, "TopLevelForInCapturedWriteUsesSharedCell")
    }

    shared {
        private func AssertEmittedResult(source string, expected int32, testName string) -> Assert.Equal(
            "$expected${Environment.NewLine}",
            CompileAndRun(source, testName)
        )

        private func CompileAndRun(source string, testName string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue2854TopLevelEllipsisLoopCaptureTests",
                testName
            )
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.True(exitCode == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            IlVerifier.Verify(assemblyPath)
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            let outputTask = process!!.StandardOutput.ReadToEndAsync()
            let errorTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(30_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            Assert.True(exited, "dotnet exec timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            Assert.True(process!!.ExitCode == 0, error)
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}

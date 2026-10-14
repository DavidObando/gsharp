// <copyright file="Issue2853EllipsisLoopCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2853: numeric ellipsis loop captures use a fresh variable cell per iteration.
/// Asserts the emitted program against pinned golden values; the interpreter
/// parity arm was retired with the evaluator in ADR-0156 Phase 3c (#3176).
open class Issue2853EllipsisLoopCaptureTests {
    @Fact
    func ClosureCapturesValueFromCreatingIteration() {
        const Source = `package Issue2853
import System

func capture() int32 {
    var callback = () -> { return -1 }

    for i in 0 ... 3 {
        if i == 0 { callback = () -> { return i } }
    }

    return callback()
}

let result = capture()
Console.WriteLine(result)
result`
        AssertEmittedResult(Source, expected: 0, "ClosureCapturesValueFromCreatingIteration")
    }

    @Fact
    func CapturedWriteAdvancesLoopControlVariable() {
        const Source = `package Issue2853Write
import System

func countIterations() int32 {
    var iterations = 0
    for i in 0 ... 5 {
        var bump = () -> { i = i + 1 }
        bump()
        iterations = iterations + 1
    }

    return iterations
}

let result = countIterations()
Console.WriteLine(result)
result`
        AssertEmittedResult(Source, expected: 3, "CapturedWriteAdvancesLoopControlVariable")
    }

    @Fact
    func CapturedFunctionLocalWritesSharedCell() {
        const Source = `package Issue2853Write
import System

func mutate() int32 {
    var value = 20
    var bump = () -> { value = value + 1 }
    bump()
    return value
}

let result = mutate()
Console.WriteLine(result)
result`
        AssertEmittedResult(Source, expected: 21, "CapturedFunctionLocalWritesSharedCell")
    }

    @Fact
    func CapturedIndexWritesUseExpressionTargets() {
        const Source = `package Issue2853CapturedIndexWrites
import System
import System.Collections.Generic

func mutate() int32 {
    var slice = []int32{1}
    var values = map[string,int32]{"x": 2}
    var list = List[int32]()
    list.Add(3)
    var read = () -> { return slice[0] + values["x"] + list[0] }

    slice[0] = 40
    values["x"] = 50
    list[0] = 60
    return slice[0] + values["x"] + list[0] + read()
}

let result = mutate()
Console.WriteLine(result)
result`
        AssertEmittedResult(Source, expected: 300, "CapturedIndexWritesUseExpressionTargets")
    }

    @Fact
    func CapturedInstanceFieldWritesUseExpressionReceivers() {
        const Source = `package Issue2853CapturedFieldWrite
import System

class Counter {
    var Value int32
}

struct Pair {
    var Value int32
}

func mutate() int32 {
    var counter = Counter()
    counter.Value = 5
    var readCounter = () -> { return counter.Value }

    var pair = Pair{Value: 1}
    var readPair = () -> { return pair.Value }
    pair.Value = 6

    return counter.Value + readCounter() + pair.Value + readPair()
}

let result = mutate()
Console.WriteLine(result)
result`
        AssertEmittedResult(Source, expected: 22, "CapturedInstanceFieldWritesUseExpressionReceivers")
    }

    @Fact
    func CapturedRefOutAndAliasWritesUseCallerCell() {
        const Source = `package Issue2853CapturedRefWrites
import System

func addOne(ref value int32) {
    value = value + 1
}

func setSeven(out value int32) {
    value = 7
}

func mutate() int32 {
    var n = 1
    var readN = () -> { return n }
    let ref alias = n
    alias = alias + 1
    addOne(ref n)

    var m = 0
    var readM = () -> { return m }
    setSeven(out m)

    return n * 1000 + readN() * 100 + m * 10 + readM()
}

let result = mutate()
Console.WriteLine(result)
result`
        AssertEmittedResult(Source, expected: 3377, "CapturedRefOutAndAliasWritesUseCallerCell")
    }

    shared {
        private func AssertEmittedResult(source string, expected int32, testName string) -> Assert.Equal(
            "$expected${Environment.NewLine}",
            CompileAndRun(source, testName)
        )

        private func CompileAndRun(source string, testName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2853EllipsisLoopCaptureTests", testName)
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

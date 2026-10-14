// <copyright file="Issue2618DelegateLikeConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2618: user callable values retain delegate variance when passed to
/// source constructors, while ordinary classes remain invalid lambda targets.
open class Issue2618DelegateLikeConversionEmitTests {
    @Fact
    func LambdaAndMethodValue_UserFunctionConstructor_Run() {
        const Source = `package P
import System

class State {
    var Value int32
}

class RelayLike {
    let execute (State) -> void
    init(action (State) -> void) {
        execute = action
    }
    func Execute() {
        execute(State{Value: 7})
    }
}

class Handler {
    func OnState(state State) {
        Console.WriteLine(state.Value)
    }
}

func Main() {
    let nullableAction = (state State?) -> {
        if state != nil {
            Console.WriteLine(state.Value)
        }
    }
    RelayLike(nullableAction).Execute()
    let handler = Handler()
    RelayLike(handler.OnState).Execute()
}`
        Assert.Equal("7${Environment.NewLine}7${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func ArbitraryClass_RemainsInvalidLambdaTarget() {
        const Source = `class Ordinary {}

func Main() {
    let invalid Ordinary = () -> {}
}`
        Assert.Contains("GS0155", CompileForDiagnostics(Source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = NewDirectory()
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            try {
                using let stdout = StringWriter()
                let previous = Console.Out
                Console.SetOut(stdout)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previous)
                }
                Assert.True(exitCode == 0, stdout.ToString())
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
                let output = process!!.StandardOutput.ReadToEnd()
                let error = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, error)
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileForDiagnostics(source string) string {
            let directory = NewDirectory()
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            try {
                using let stdout = StringWriter()
                let previous = Console.Out
                Console.SetOut(stdout)
                try {
                    Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previous)
                }
                return stdout.ToString()
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func NewDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2618", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }
    }
}

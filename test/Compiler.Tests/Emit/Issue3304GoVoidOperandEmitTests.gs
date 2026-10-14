// <copyright file="Issue3304GoVoidOperandEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Reflection
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #3304: `go` with a void-returning call operand must compile to
/// verifiable IL and run. The void operand lowers through the Action-shaped
/// goroutine thunk (the closure's InvokeAction body is an expression
/// statement, so a void call leaves nothing to pop), for both fire-and-forget
/// and scope-joined launches.
open class Issue3304GoVoidOperandEmitTests {
    @Fact
    func GoVoidOperandShapes_LoadVerifyAndRun() {
        const Source = `package Issue3304GoVoid
import System

class Box {
    func Poke(ch chan[int32]) {
        ch <- 7
    }
}

func poke(ch chan[int32]) {
    ch <- 42
}

let done = chan[int32](1)
go poke(done)
Console.WriteLine(<-done)

let b = Box{}
go b.Poke(done)
Console.WriteLine(<-done)

scope {
    go poke(done)
}
Console.WriteLine(<-done)`
        AssertRuns(Source, "GoVoidOperandShapes_LoadVerifyAndRun", `42
7
42
`)
    }

    shared {
        private func AssertRuns(source string, name string, expected string) {
            let assemblyPath = Compile(source, name)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            for var i = 0; i < 3; i++ {
                Assert.Equal(expected, RunBounded(assemblyPath, name))
            }
            IlVerifier.Verify(assemblyPath)
        }

        private func Compile(source string, name string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue3304GoVoidOperandEmitTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            Assert.True(exitCode == 0, ("$name" + `: gsc failed:
` + "$stdout" + `
` + "$stderr"))
            return assemblyPath
        }

        private func RunBounded(assemblyPath string, name string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let outputTask = process!!.StandardOutput.ReadToEndAsync()
            let errorTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(10_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            Assert.True(exited, "$name: emitted program timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            Assert.True(process!!.ExitCode == 0, ("$name" + `: emitted program failed:
` + "$error"))
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}

// <copyright file="Issue3084TupleAsyncFunctionMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

class Issue3084TupleAsyncFunctionMemberTests {
    @Fact
    func TupleAsyncFunctionItem4_BindsVerifiesAndRuns() {
        const source = `package Issue3084

import System
import System.Linq
import System.Threading.Tasks

class Payload(Value string) { }

async func RunAsync() string {
    let handler async (Payload) -> string = async (value Payload) -> {
        await Task.Yield()
        return value.Value
    }
    let state object = 42
    let tuples = [](string, string, object, async (Payload) -> string){
        ("first", "second", state, handler)
    }
    let tuple = tuples!!.FirstOrDefault((candidate (string, string, object, async (Payload) -> string)) -> candidate.Item1 == "first")
    Console.WriteLine(tuple.Item1)
    return await tuple.Item4(Payload("result"))
}

Console.WriteLine(RunAsync().GetAwaiter().GetResult())`
        Assert.Equal("first${Environment.NewLine}result${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3084TupleAsyncFunctionMemberTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue3084.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$standardOut$standardError")
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
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}

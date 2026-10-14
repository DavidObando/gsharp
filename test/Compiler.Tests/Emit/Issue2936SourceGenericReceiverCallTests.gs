// <copyright file="Issue2936SourceGenericReceiverCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2936: calls through source-generic member results retain their
/// substituted function type.
open class Issue2936SourceGenericReceiverCallTests {
    @Fact
    func SourceGenericReceiverReturnedFunction_LoadsAndRuns() {
        const Source = `package SourceGenericFunctionReceiver
import System

class Src { let N int32
            init(n int32) { N = n } }

class Box[T any] { let Value T
                   init(value T) { Value = value }
                   func Get(index int32) T -> Value }

func Main() {
    let box = Box[(Src) -> int32]((item Src) -> item.N)
    Console.WriteLine(box.Get(0)(Src(5)))
}`
        let directory = Directory.CreateTempSubdirectory("gsharp_issue2936_").FullName
        try {
            let assemblyPath = Compile(Source, directory)
            IlVerifier.Verify(assemblyPath)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            Assert.Equal("5${Environment.NewLine}", RunBounded(assemblyPath))
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func Compile(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "Program.gs")
            let assemblyPath = Path.Combine(directory, "Issue2936.dll")
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
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return assemblyPath
        }

        private func RunBounded(assemblyPath string) string {
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
            let stdoutTask = process!!.StandardOutput.ReadToEndAsync()
            let stderrTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(30_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            let stdout = stdoutTask.GetAwaiter().GetResult()
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(exited, "emitted program timed out")
            Assert.True(process!!.ExitCode == 0, (`emitted program failed:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}

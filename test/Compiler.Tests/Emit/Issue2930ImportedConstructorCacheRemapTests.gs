// <copyright file="Issue2930ImportedConstructorCacheRemapTests.cs" company="GSharp">
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

/// Issue #2930: imported symbolic constructor cache entries include active
/// generic remap identities.
open class Issue2930ImportedConstructorCacheRemapTests {
    @Fact
    func ImportedConstructorCache_SeparatesLambdaMethodRemaps() {
        const Source = `package Issue2930Method

import System
import System.Collections.Generic

func Remap[A, B](first A, value B) B {
    var outer = List[B]()
    outer.Add(value)
    let f (B) -> B = (innerValue B) -> {
        var inner = List[B]()
        inner.Add(innerValue)
        return inner[0]
    }
    return f(outer[0])
}

Console.WriteLine(Remap[int32, int32](0, 11))
Console.WriteLine(Remap[int32, int32](0, 22))`
        AssertRunsWithExactOutput(Source, "ImportedConstructorCache_SeparatesLambdaMethodRemaps", `11
22
`)
    }

    @Fact
    func ImportedConstructorCache_SeparatesClosureClassRemaps() {
        const Source = `package Issue2930Class

import System
import System.Collections.Generic

func Remap[A, B](first A, value B) B {
    var outer = List[B]()
    outer.Add(value)
    var calls = 0
    let f (B) -> B = (innerValue B) -> {
        calls++
        var inner = List[B]()
        inner.Add(innerValue)
        return inner[0]
    }
    return f(outer[0])
}

Console.WriteLine(Remap[int32, int32](0, 33))
Console.WriteLine(Remap[int32, int32](0, 44))`
        AssertRunsWithExactOutput(Source, "ImportedConstructorCache_SeparatesClosureClassRemaps", `33
44
`)
    }

    shared {
        private func AssertRunsWithExactOutput(source string, name string, expected string) {
            let assemblyPath = Compile(source, name)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            Assert.Equal(expected, Run(assemblyPath, name))
            IlVerifier.Verify(assemblyPath)
        }

        private func Compile(source string, name string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2930ImportedConstructorCacheRemapTests", name)
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

        private func Run(assemblyPath string, name string) string {
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
            let exited = process!!.WaitForExit(30_000)
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

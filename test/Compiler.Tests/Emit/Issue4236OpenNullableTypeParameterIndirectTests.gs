// <copyright file="Issue4236OpenNullableTypeParameterIndirectTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Nullable by-reference storage requires a known type-parameter kind (ADR-0224).
/// The value-kind control checks both primitive and user-defined struct storage.
open class Issue4236OpenNullableTypeParameterIndirectTests {
    @Fact
    func OutAndRefNullableTypeParameter_RequiresKindAndPreservesStructStorage() {
        const Source = `package Issue4236
import System

data struct Pair(Value int32)

class Box[T] {
    func TrySet(input T, out value T?) bool {
        value = input
        return true
    }

    func Reassign(ref value T?, replacement T) T {
        let old = value!!
        value = replacement
        return old
    }

    func RoundTripOut(input T) T {
        TrySet(input, out var captured)
        return captured!!
    }

    func RoundTripRef(input T, replacement T) T {
        var value T? = input
        return Reassign(ref value, replacement)
    }
}

let pairBox = Box[Pair]()
Console.WriteLine(pairBox.RoundTripOut(Pair(7)).Value)
let intBox = Box[int32]()
Console.WriteLine(intBox.RoundTripOut(9))
Console.WriteLine(pairBox.RoundTripRef(Pair(11), Pair(12)).Value)
Console.WriteLine(intBox.RoundTripRef(13, 14))`
        Issue6040GenericNullableReturnDriverTests.CheckRejected(
            Source,
            []string{"GS0641@7,37,7,38", "GS0641@12,30,12,31", "GS0641@24,20,24,21"}
        )
        AssertRuns(
            Source.Replace("class Box[T] {", "class Box[T struct] {"),
            "OutAndRefNullableTypeParameter_RequiresKindAndPreservesStructStorage",
            `7
9
11
13
`
        )
    }

    shared {
        private func AssertRuns(source string, name string, expected string) {
            let assemblyPath = Compile(source, name)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            Assert.Equal(expected, RunBounded(assemblyPath, name))
            IlVerifier.Verify(assemblyPath)
        }

        private func Compile(source string, name string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4236OpenNullableTypeParameterIndirectTests",
                name
            )
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

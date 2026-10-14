// <copyright file="Issue3089ObjectNilEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

class Issue3089ObjectNilEqualityTests {
    @Fact
    func ObjectValues_CompareWithNil_VerifyAndRun() {
        const Source = `package Issue3089

import System

func IsNil(value object) bool -> value == nil
func IsNotNil(value object) bool -> value != nil
func IsNullableNil(value object?) bool -> value == nil
func IsNullableNotNil(value object?) bool -> value != nil

func ConvertValue(value object?) string? ->
    value is DBNull || value == nil ? nil : value as string

func Main() {
    let nilValue object = default(object)
    let textValue object = "text"
    let dbNullValue object = DBNull.Value

    Console.WriteLine(IsNil(nilValue))
    Console.WriteLine(IsNil(textValue))
    Console.WriteLine(IsNil(dbNullValue))
    Console.WriteLine(IsNotNil(nilValue))
    Console.WriteLine(IsNotNil(textValue))
    Console.WriteLine(IsNotNil(dbNullValue))

    let nullableNil object? = nil
    let nullableText object? = "text"
    let nullableDbNull object? = DBNull.Value

    Console.WriteLine(IsNullableNil(nullableNil))
    Console.WriteLine(IsNullableNil(nullableText))
    Console.WriteLine(IsNullableNil(nullableDbNull))
    Console.WriteLine(IsNullableNotNil(nullableNil))
    Console.WriteLine(IsNullableNotNil(nullableText))
    Console.WriteLine(IsNullableNotNil(nullableDbNull))

    Console.WriteLine(ConvertValue(nullableNil) ?? "<nil>")
    Console.WriteLine(ConvertValue(nullableText) ?? "<nil>")
    Console.WriteLine(ConvertValue(nullableDbNull) ?? "<nil>")
}`
        Assert.Equal(`True
False
False
False
True
True
True
False
False
False
True
True
<nil>
text
<nil>
`.ReplaceLineEndings(Environment.NewLine), CompileVerifyAndRun(Source))
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3089ObjectNilEqualityTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue3089.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    sourcePath
                }
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$stdout$stderr")
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
                Assert.True(process!!.ExitCode == 0, "exited ${process!!.ExitCode}:${Environment.NewLine}$error")
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}

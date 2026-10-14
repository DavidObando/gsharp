// <copyright file="Issue3081CompositeLiteralInheritedFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Reflection
import GSharp.Tests
import Xunit
import CompilerProgram = GSharp.Compiler.Program
import GSharp.Compiler.Tests

/// Issue #3081: composite literals preserve inherited field declaring types.
open class Issue3081CompositeLiteralInheritedFieldTests {
    @Fact
    func CompositeLiteralFieldMatrix_GscEvaluateAndEmit() {
        AssertCompilerDrivers(
            "TopLevel",
            Issue3081CompositeLiteralCases.BuildMatrixSource(inFunction: false),
            Issue3081CompositeLiteralCases.BuildMatrixOutput(100)
        )
        AssertCompilerDrivers(
            "InFunction",
            Issue3081CompositeLiteralCases.BuildMatrixSource(inFunction: true),
            Issue3081CompositeLiteralCases.BuildMatrixOutput(200)
        )
    }

    @Fact
    func CompositeLiteralFalsePositiveCorpus_GscEvaluateAndEmit() {
        AssertCompilerDrivers(
            "Controls",
            Issue3081CompositeLiteralCases.Controls,
            Issue3081CompositeLiteralCases.ControlsOutput
        )
    }

    @Fact
    func ObjectInitializerInheritedGenericBaseField_GscEvaluateAndEmit() {
        AssertCompilerDrivers(
            "ObjectInitializer",
            Issue3081CompositeLiteralCases.ObjectInitializer,
            Issue3081CompositeLiteralCases.ObjectInitializerOutput
        )
    }

    @Fact
    func CompositeLiteralLowering_PreservesInheritedFieldDeclaringType() {
        AssertCompilerDrivers(
            "Lowering",
            Issue3081CompositeLiteralCases.Lowering,
            Issue3081CompositeLiteralCases.LoweringOutput
        )
    }

    @Fact
    func CompositeLiteralAsyncSpill_PreservesInheritedFieldDeclaringType() {
        AssertCompilerDrivers(
            "AsyncSpill",
            Issue3081CompositeLiteralCases.AsyncSpill,
            Issue3081CompositeLiteralCases.AsyncSpillOutput
        )
    }

    private data struct DriverResult(ExitCode int32, Stdout string, Stderr string) : IEquatable[
        Issue3081CompositeLiteralInheritedFieldTests.DriverResult
    ] { }

    shared {
        private func AssertCompilerDrivers(name string, source string, expected string) {
            AssertBareCompiler(name, source, expected)
            AssertEmittedCompiler(name, source, expected)
        }

        private func AssertBareCompiler(name string, source string, expected string) {
            let result = InEmptyDirectory(
                name + "-gsc",
                (directory string) -> {
                    let sourcePath = Path.Combine(directory, "test.gs")
                    File.WriteAllText(sourcePath, source)
                    return CaptureConsole(() -> CompilerProgram.Main([]string{"/nowarn:GS9100", sourcePath}))
                }
            )
            Assert.True(result.ExitCode == 0, ("$name" + ` gsc failed:
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            Assert.Equal(expected + "Success.${Environment.NewLine}", result.Stdout)
            Assert.Equal(string.Empty, result.Stderr)
        }

        private func AssertEmittedCompiler(name string, source string, expected string) {
            InEmptyDirectory(
                name + "-emit",
                (directory string) -> {
                    let sourcePath = Path.Combine(directory, "test.gs")
                    let assemblyPath = Path.Combine(directory, "program.dll")
                    File.WriteAllText(sourcePath, source)
                    let compile = CaptureConsole(
                        () -> CompilerProgram.Main(
                            []string{
                                "/out:" + assemblyPath,
                                "/target:exe",
                                "/targetframework:net10.0",
                                "/nowarn:GS9100",
                                sourcePath
                            }
                        )
                    )
                    Assert.True(compile.ExitCode == 0, ("$name" + ` emit failed:
` + "${compile.Stdout}" + `
` + "${compile.Stderr}"))
                    Assert.Equal(string.Empty, compile.Stderr)
                    let assembly = EmittedFixture.Load(assemblyPath)
                    Assert.NotEmpty(assembly.GetTypes())
                    using let process Process? = Process.Start(
                        ProcessStartInfo("dotnet"){
                            ArgumentList = {assemblyPath},
                            WorkingDirectory = directory,
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
                    let stdout = Normalize(stdoutTask.GetAwaiter().GetResult())
                    let stderr = Normalize(stderrTask.GetAwaiter().GetResult())
                    Assert.True(exited, "$name emitted program timed out.")
                    Assert.True(
                        process!!.ExitCode == 0,
                        ("$name" + ` emitted program exited ` + "${process!!.ExitCode}" + `:
` + "$stdout" + `
` + "$stderr")
                    )
                    Assert.Equal(expected, stdout)
                    Assert.Equal(string.Empty, stderr)
                    IlVerifier.Verify(assemblyPath)
                    return 0
                }
            )
        }

        private func CaptureConsole(action() -> int32) Issue3081CompositeLiteralInheritedFieldTests.DriverResult {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return Issue3081CompositeLiteralInheritedFieldTests.DriverResult(
                    action(),
                    Normalize(stdout.ToString()),
                    Normalize(stderr.ToString())
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func InEmptyDirectory[T](name string, action(string) -> T) T {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3081CompositeLiteralInheritedFieldTests",
                name + "-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory))
            try {
                return action(directory)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func Normalize(text string) string -> text.ReplaceLineEndings(Environment.NewLine)
    }
}

// <copyright file="Issue3081CompositeLiteralInheritedFieldTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Tests
import ReplProgram = GSharp.Repl.Program
import System
import System.IO
import Xunit

/// Issue #3081: Emitted-execution coverage for composite literal inherited field.
open class Issue3081CompositeLiteralInheritedFieldTests {
    @Fact
    func CompositeLiteralFieldMatrix_Gsi() {
        AssertGsi(
            "TopLevel",
            Issue3081CompositeLiteralCases.BuildMatrixSource(inFunction: false),
            Issue3081CompositeLiteralCases.BuildMatrixOutput(100)
        )
        AssertGsi(
            "InFunction",
            Issue3081CompositeLiteralCases.BuildMatrixSource(inFunction: true),
            Issue3081CompositeLiteralCases.BuildMatrixOutput(200)
        )
    }

    @Fact
    func CompositeLiteralFalsePositiveCorpus_Gsi() -> AssertGsi(
        "Controls",
        Issue3081CompositeLiteralCases.Controls,
        Issue3081CompositeLiteralCases.ControlsOutput
    )

    @Fact
    func ObjectInitializerInheritedGenericBaseField_Gsi() -> AssertGsi(
        "ObjectInitializer",
        Issue3081CompositeLiteralCases.ObjectInitializer,
        Issue3081CompositeLiteralCases.ObjectInitializerOutput
    )

    @Fact
    func CompositeLiteralLowering_Gsi() -> AssertGsi(
        "Lowering",
        Issue3081CompositeLiteralCases.Lowering,
        Issue3081CompositeLiteralCases.LoweringOutput
    )

    @Fact
    func CompositeLiteralAsyncSpill_Gsi() -> AssertGsi(
        "AsyncSpill",
        Issue3081CompositeLiteralCases.AsyncSpill,
        Issue3081CompositeLiteralCases.AsyncSpillOutput
    )

    private data struct DriverResult(ExitCode int32, Stdout string, Stderr string) : IEquatable[
        Issue3081CompositeLiteralInheritedFieldTests.DriverResult
    ] { }

    shared {
        private func AssertGsi(name string, source string, expected string) {
            let result = InEmptyDirectory(
                name,
                (directory string) -> {
                    let sourcePath = Path.Combine(directory, "test.gs")
                    File.WriteAllText(sourcePath, source)
                    return CaptureConsole(() -> ReplProgram.Main([]string{sourcePath}))
                }
            )
            Assert.True(result.ExitCode == 0, ("$name" + ` gsi failed:
` + "${result.Stdout}" + `
` + "${result.Stderr}"))
            Assert.Equal(expected, result.Stdout)
            Assert.Equal(string.Empty, result.Stderr)
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

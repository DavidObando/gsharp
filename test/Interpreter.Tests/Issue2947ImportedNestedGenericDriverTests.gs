// <copyright file="Issue2947ImportedNestedGenericDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Repl
import System
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #2947: Emitted-execution coverage for imported nested generic.
@Collection("ConsoleIo")
open class Issue2947ImportedNestedGenericDriverTests {
    @Fact
    func ImportedNestedTypes_PreserveArgumentsAcrossMatrixAndAllDrivers() {
        let directory = CreateEmptyTestDirectory()
        try {
            let libraryPath = Path.Combine(directory, "glib.dll")
            let librarySourcePath = WriteSource(directory, "lib.gs", LibrarySource)
            let library = RunCompiler("/target:library", "/out:" + libraryPath, librarySourcePath)
            AssertSucceeded(library, "library")
            let reportedPath = WriteSource(directory, "reported.gs", ReportedSource)
            let bare = RunCompiler("/nowarn:GS9100", "/r:" + libraryPath, reportedPath)
            AssertSucceeded(bare, "reported bare gsc")
            Assert.Equal("Success.${Environment.NewLine}", Normalize(bare.StandardOutput))
            Assert.Equal(string.Empty, bare.StandardError)
            let executedReportedPath = WriteSource(directory, "reported-executed.gs", ExecutedReportedSource)
            let reportedAssemblyPath = Path.Combine(directory, "reported.dll")
            let emitted = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + reportedAssemblyPath,
                "/r:" + libraryPath,
                executedReportedPath
            )
            AssertSucceeded(emitted, "reported emit")
            Assert.Equal("5${Environment.NewLine}", RunAssembly(directory, reportedAssemblyPath))
            let _ = Assembly.LoadFrom(libraryPath)
            let gsi = RunGsi(executedReportedPath)
            AssertSucceeded(gsi, "reported gsi")
            Assert.Equal("5${Environment.NewLine}", Normalize(gsi.StandardOutput))
            Assert.Equal(string.Empty, gsi.StandardError)
            let diagnosticPath = WriteSource(directory, "diagnostic.gs", DiagnosticSource)
            let bareDiagnostics = RunCompiler("/nowarn:GS9100", "/r:" + libraryPath, diagnosticPath)
            let emitDiagnostics = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + Path.Combine(directory, "diagnostic.dll"),
                "/r:" + libraryPath,
                diagnosticPath
            )
            let gsiDiagnostics = RunGsi(diagnosticPath)
            Assert.Equal(1, bareDiagnostics.ExitCode)
            Assert.Equal(1, emitDiagnostics.ExitCode)
            Assert.Equal(1, gsiDiagnostics.ExitCode)
            Assert.Equal(ExpectedDiagnostics, ExtractDiagnosticMessages(bareDiagnostics.Combined))
            Assert.Equal(ExpectedDiagnostics, ExtractDiagnosticMessages(emitDiagnostics.Combined))
            Assert.Equal(ExpectedDiagnostics, ExtractDiagnosticMessages(gsiDiagnostics.Combined))
            Assert.DoesNotContain("object", bareDiagnostics.Combined, StringComparison.Ordinal)
            Assert.DoesNotContain("object", emitDiagnostics.Combined, StringComparison.Ordinal)
            Assert.DoesNotContain("object", gsiDiagnostics.Combined, StringComparison.Ordinal)
            let fullMatrix = CreateMatrixSource(includeReportedCells: true)
            Assert.Equal(36, fullMatrix.SiteCount)
            CompileAndRunMatrix(directory, libraryPath, "matrix-full", fullMatrix)
            let falsePositiveMatrix = CreateMatrixSource(includeReportedCells: false)
            Assert.Equal(34, falsePositiveMatrix.SiteCount)
            CompileAndRunMatrix(directory, libraryPath, "matrix-controls", falsePositiveMatrix)
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    private data class DriverResult(ExitCode int32, StandardOutput string, StandardError string) : IEquatable[
        Issue2947ImportedNestedGenericDriverTests.DriverResult
    ] {
        prop Combined string -> StandardOutput + StandardError
    }

    private data class MatrixSource(Source string, SiteCount int32, ExpectedValue int32) : IEquatable[MatrixSource] { }

    shared {
        private const LibrarySource string = `package glib

public struct Outer[T] {
    public enum Color { Red = 4, Green = 5, Blue = 6 }
    public struct Value { public var N int32 }
    public class Ref { public var N int32 }

    public struct Mid {
        public enum Tone { Red = 7, Green = 8, Blue = 9 }
        public struct Value { public var N int32 }
        public class Ref { public var N int32 }
    }
}`

        private const ReportedSource string = `package z2947b
struct Holder[T] {
    public func Take() int32 {
        var c glib.Outer[T].Color = glib.Outer[T].Color.Green
        return int32(c)
    }
}

17`

        private const ExecutedReportedSource string = `package z2947b
import System

struct Holder[T] {
    public func Take() int32 {
        var c glib.Outer[T].Color = glib.Outer[T].Color.Green
        return int32(c)
    }
}

Console.WriteLine(Holder[string]{}.Take())`

        private const DiagnosticSource string = `package z2947b

struct Holder[T] {
    public func Take() int32 {
        var exact glib.Outer[T].Color = glib.Outer[T].Color.Green
        var maybe glib.Outer[T].Color? = exact
        var c glib.Outer[T].Color = maybe
        var i int32 = exact
        return i
    }
}

Holder[string]{}.Take()`

        private let ExpectedDiagnostics[]string = []string{
            "Cannot convert type 'glib.Outer[T].Color?' to 'glib.Outer[T].Color'. An explicit conversion exists (are you missing a cast?)",
            "Cannot convert type 'glib.Outer[T].Color' to 'int32'. An explicit conversion exists (are you missing a cast?)"
        }

        private func CreateMatrixSource(includeReportedCells bool) MatrixSource {
            let source = StringBuilder(`package matrix2947
import System
import System.Collections.Generic

public struct LocalOuter[T] {
    public enum Color { Red = 1, Green = 2 }
    public struct Value { public var N int32 }
    public class Ref { public var N int32 }

    public struct Mid {
        public enum Tone { Red = 3, Green = 4 }
        public struct Value { public var N int32 }
        public class Ref { public var N int32 }
    }
}

struct Holder[T] {
    func Check() int32 {
        var total int32 = 0`)
            var siteCount = 0
            var expected = 0
            for imported in[]bool{true, false} {
                let outer = if imported {
                    "glib.Outer"
                } else {
                    "LocalOuter"
                }
                for argument in[]string{"T", "int32", "List[int32]"} {
                    for depth in[]string{string.Empty, ".Mid"} {
                        for kind in[]string{"enum", "struct", "class"} {
                            if !includeReportedCells && imported && argument == "T" && kind == "enum" {
                                continue
                            }
                            siteCount++
                            let suffix = switch kind {
                                case "enum": if depth.Length == 0 {
                                    "Color"
                                } else {
                                    "Tone"
                                }
                                case "struct": "Value"
                                default: "Ref"
                            }
                            let type = "$outer[$argument]$depth.$suffix"
                            let expression = if kind == "enum" {
                                type + ".Green"
                            } else {
                                "default($type)"
                            }
                            source.AppendLine("        var value$siteCount $type = $expression")
                            switch kind {
                                case "enum" {
                                    source.AppendLine("        total += int32(value$siteCount)")
                                    expected += if depth.Length == 0 {
                                        (
                                            if imported {
                                                5
                                            } else {
                                                2
                                            }
                                        )
                                    } else {
                                        (
                                            if imported {
                                                8
                                            } else {
                                                4
                                            }
                                        )
                                    }
                                }
                                case "struct" {
                                    source.AppendLine("        total += value$siteCount.N")
                                }
                                default {
                                    source.AppendLine("        if value$siteCount == nil { total += 1 }")
                                    expected++
                                }
                            }
                        }
                    }
                }
            }
            source.AppendLine("        return total")
            source.AppendLine("    }")
            source.AppendLine("}")
            source.AppendLine("Console.WriteLine(Holder[string]{}.Check())")
            return MatrixSource(source.ToString(), siteCount, expected)
        }

        private func CompileAndRunMatrix(directory string, libraryPath string, name string, matrix MatrixSource) {
            let sourcePath = WriteSource(directory, name + ".gs", matrix.Source)
            let assemblyPath = Path.Combine(directory, name + ".dll")
            let compilation = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + assemblyPath,
                "/r:" + libraryPath,
                sourcePath
            )
            AssertSucceeded(compilation, name)
            Assert.Equal(matrix.ExpectedValue.ToString() + Environment.NewLine, RunAssembly(directory, assemblyPath))
        }

        private func RunCompiler(
            arguments ...string
        ) Issue2947ImportedNestedGenericDriverTests.DriverResult -> Issue2947ImportedNestedGenericDriverTests.Capture(
            () -> GSharp.Compiler.Program.Main(arguments)
        )

        private func RunGsi(
            sourcePath string
        ) Issue2947ImportedNestedGenericDriverTests.DriverResult -> Issue2947ImportedNestedGenericDriverTests.Capture(
            () -> GSharp.Repl.Program.Main([]string{sourcePath})
        )

        private func Capture(action() -> int32) Issue2947ImportedNestedGenericDriverTests.DriverResult {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                return Issue2947ImportedNestedGenericDriverTests.DriverResult(
                    action(),
                    stdout.ToString(),
                    stderr.ToString()
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func RunAssembly(directory string, assemblyPath string) string {
            let runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
            File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let result = DotnetProcess.Run(directory, "exec", "--runtimeconfig", runtimeConfigPath, assemblyPath)
            Assert.True(result.ExitCode == 0, (`Emitted assembly exited ` + "${result.ExitCode}" + `
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
            return Normalize(result.StandardOutput)
        }

        private func ExtractDiagnosticMessages(output string)[]string -> Regex
            .Matches(output, "error GS0156: (?<message>[^\\r\\n]+)")
            .Select((match Match) -> match.Groups["message"].Value)
            .ToArray()

        private func AssertSucceeded(
            result Issue2947ImportedNestedGenericDriverTests.DriverResult,
            operation string
        ) -> Assert
            .True(result.ExitCode == 0, ("$operation" + ` exited ` + "${result.ExitCode}" + `
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))

        private func WriteSource(directory string, fileName string, source string) string {
            let path = Path.Combine(directory, fileName)
            File.WriteAllText(path, source)
            return path
        }

        private func CreateEmptyTestDirectory() string {
            let root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts")
            Directory.CreateDirectory(root)
            let path = Path.Combine(root, "${"Issue2947ImportedNestedGenericDriverTests"}-${Guid.NewGuid():N}")
            Directory.CreateDirectory(path)
            Assert.Empty(Directory.GetFileSystemEntries(path))
            return path
        }

        private func Normalize(value string) string -> value.ReplaceLineEndings(Environment.NewLine)
    }
}

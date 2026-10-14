// <copyright file="Issue2715ForRangeNestedCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2715: a for-range variable captured by a nested lambda inside an
/// outer lambda was boxed without allocating the box in the outer closure.
open class Issue2715ForRangeNestedCaptureEmitTests {
    @Fact
    func OahuPlainOutputWriter_OuterSafeWriteForRowNestedSelect_RunsAndVerifies() {
        const Source = `package Oahu.Cli.Output
import System
import System.Collections.Generic
import System.IO
import System.Linq

class OutputColumn(key string, header string) {
    prop Key string -> key
    prop Header string -> header
}

class PlainOutputWriter {
    private let writer TextWriter

    init(writer TextWriter) {
        this.writer = writer
    }

    func WriteCollection(resourceName string, rows IReadOnlyList[IReadOnlyDictionary[string, object?]], columns IReadOnlyList[OutputColumn]) {
        PlainOutputWriter.SafeWrite(() -> {
            writer.WriteLine(String.Join('\t', columns.Select((c OutputColumn) -> c.Header)))
            for row in rows {
                writer.WriteLine(String.Join('\t', columns.Select((c OutputColumn) -> PlainOutputWriter.Format(if row!!.TryGetValue(c.Key, out var v) { v } else { default(object?) }))))
            }
        })
    }

    shared {
        private func SafeWrite(action () -> void) {
            try {
                action()
            } catch (ex IOException) {
            } catch (ex ObjectDisposedException) {
            }
        }

        private func Format(value object?) string {
            return value?.ToString() ?? String.Empty
        }
    }
}

var first = Dictionary[string, object?]()
first.Add("left", "a")
first.Add("right", "b")
var second = Dictionary[string, object?]()
second.Add("left", "c")
second.Add("right", "d")
var rows = List[IReadOnlyDictionary[string, object?]]{ first, second }
var columns = List[OutputColumn]{ OutputColumn("right", "R"), OutputColumn("left", "L") }
let output = StringWriter()
PlainOutputWriter(output).WriteCollection("items", rows, columns)
Console.Write(output.ToString())`
        Assert.Equal(
            "R\tL${Environment.NewLine}b\ta${Environment.NewLine}d\tc${Environment.NewLine}",
            CompileVerifyAndRun(Source, "Oahu")
        )
    }

    @Fact
    func ForRange_EscapingClosures_GetFreshBoxPerIteration() {
        const Source = `package ForRangeCapture
import System
import System.Collections.Generic

func SafeWrite(action () -> void) {
    action()
}

var values = List[int32]{ 1, 2, 3 }
var readers = List[(() -> int32)]()
SafeWrite(() -> {
    for value in values {
        readers.Add(() -> value)
    }
})
Console.WriteLine(readers[0]())
Console.WriteLine(readers[1]())
Console.WriteLine(readers[2]())`
        Assert.Equal(
            "1${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}",
            CompileVerifyAndRun(Source, "Escaping")
        )
    }

    @Fact
    func ForRange_KeyAndValueCapturedByNestedClosure_RunsAndVerifies() {
        const Source = `package ForRangeKeyValueCapture
import System
import System.Collections.Generic

var values = List[string]{ "a", "b" }
var readers = List[(() -> string)]()
let outer = () -> {
    for index, value in values {
        readers.Add(() -> index.ToString() + value)
    }
}
outer()
Console.WriteLine(readers[0]())
Console.WriteLine(readers[1]())`
        Assert.Equal("0a${Environment.NewLine}1b${Environment.NewLine}", CompileVerifyAndRun(Source, "KeyValue"))
    }

    @Fact
    func ForRange_VariableOutsideLoop_RemainsRejected() {
        let syntax = SyntaxTree.Parse(SourceText.From(`package ForRangeCaptureNegative
import System.Collections.Generic

func Run() {
    for value in List[int32]{ 1 } {}
    let invalid = () -> value
}`))
        let compilation = Compilation(syntax)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2715.Negative")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0125")
    }

    shared {
        private func CompileVerifyAndRun(source string, caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2715Emit", caseName)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
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
        }
    }
}

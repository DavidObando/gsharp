// <copyright file="Issue3087GenericTupleCollectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Diagnostics
import System.Globalization
import System.IO
import System.Text
import Xunit

class Issue3087GenericTupleCollectionTests {
    @Fact
    func FourElementTuple_ListAndDictionaryWhere_CompileVerifyAndRun() {
        const Source = `package Issue3087

import System
import System.Collections.Generic
import System.Linq

let values = List[(int32, int32, float64, TimeSpan)]()
values.Add((1, 2, 0.5, TimeSpan.Zero))
values.Add((3, 4, 1.5, TimeSpan.FromSeconds(2)))

let filtered = values.Where((value) -> value.Item3 > 1.0).ToList()
if filtered.Count != 1 { Environment.Exit(11) }
let item = filtered[0]
if item.Item1 != 3 { Environment.Exit(12) }
if item.Item2 != 4 { Environment.Exit(13) }
if item.Item3 != 1.5 { Environment.Exit(14) }
if item.Item4 != TimeSpan.FromSeconds(2) { Environment.Exit(15) }

let dictionary = Dictionary[string, (int32, int32, float64, TimeSpan)]()
dictionary.Add("low", (1, 2, 0.5, TimeSpan.Zero))
dictionary.Add("high", (3, 4, 1.5, TimeSpan.FromSeconds(2)))

let filteredValues = dictionary.Values.Where((value) -> value.Item3 > 1.0).ToList()
if filteredValues.Count != 1 { Environment.Exit(21) }
let dictionaryItem = filteredValues[0]
if dictionaryItem.Item1 != 3 { Environment.Exit(22) }
if dictionaryItem.Item2 != 4 { Environment.Exit(23) }
if dictionaryItem.Item3 != 1.5 { Environment.Exit(24) }
if dictionaryItem.Item4 != TimeSpan.FromSeconds(2) { Environment.Exit(25) }

Console.WriteLine("ok")`
        Assert.Equal("ok${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    @Fact
    func SymbolicTupleCollections_AllClrTupleNodes_CompileVerifyAndRun() {
        Assert.Equal("ok${Environment.NewLine}", CompileVerifyAndRun(BuildSymbolicTupleMatrixSource()))
    }

    shared {
        private func BuildSymbolicTupleMatrixSource() string {
            let source = StringBuilder(`package Issue3087Symbolic

import System
import System.Collections.Generic
import System.Linq

class Box(Value int32) { }
`)
            for var arity = 2; arity <= 16; arity++ {
                let types = [arity]string
                let values = [arity]string
                types[0] = "Box"
                values[0] = "Box($arity)"
                for var index = 1; index < arity - 1; index++ {
                    types[index] = "int32"
                    values[index] = (index + 1).ToString(CultureInfo.InvariantCulture)
                }
                types[^1] = "TimeSpan"
                values[^1] = "TimeSpan.FromSeconds($arity)"
                let tupleType = "(" + string.Join(", ", types) + ")"
                let tupleValue = "(" + string.Join(", ", values) + ")"
                source.AppendLine("let list$arity List[$tupleType] = List[$tupleType]()")
                source.AppendLine("list$arity.Add($tupleValue)")
                source.AppendLine("let filtered$arity = list$arity.Where((value) -> value.Item1.Value > 0).ToList()")
                source.AppendLine("if filtered$arity.Count != 1 { Environment.Exit(${100 + arity}) }")
                source.AppendLine("if filtered$arity[0].Item1.Value != $arity { Environment.Exit(${120 + arity}) }")
                source.AppendLine(
                    "if filtered$arity[0].Item$arity != TimeSpan.FromSeconds($arity) { Environment.Exit(${140 + arity}) }"
                )
                source.AppendLine("let dictionary$arity = Dictionary[string, $tupleType]()")
                source.AppendLine("dictionary$arity.Add(\"value\", $tupleValue)")
                source.AppendLine(
                    "let values$arity = dictionary$arity.Values.Where((value) -> value.Item1.Value > 0).ToList()"
                )
                source.AppendLine("if values$arity.Count != 1 { Environment.Exit(${160 + arity}) }")
                source.AppendLine(
                    "if values$arity[0].Item$arity != TimeSpan.FromSeconds($arity) { Environment.Exit(${180 + arity}) }"
                )
                source.AppendLine()
            }
            source.AppendLine(`let queue = Queue[(Box, int32, int32, int32, int32, int32, int32, TimeSpan)]()
queue.Enqueue((Box(8), 2, 3, 4, 5, 6, 7, TimeSpan.FromSeconds(8)))
if queue.Dequeue().Item8 != TimeSpan.FromSeconds(8) { Environment.Exit(208) }

let patternTuple = (Box(8), 2, 3, 4, 5, 6, 7, 8)
let patternResult = switch patternTuple { case { Item8: 8 }: "hit" default: "miss" }
if patternResult != "hit" { Environment.Exit(209) }

Console.WriteLine("ok")`)
            return source.ToString()
        }

        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3087GenericTupleCollectionTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue3087.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                for reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths() {
                    arguments.Add("/r:" + reference)
                }
                arguments.Add(sourcePath)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(arguments.ToArray())
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

// <copyright file="Issue1046JaggedArrayEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// End-to-end emit tests for issue #1046 — jagged/nested array types. The
/// array/slice element is now a full nested type clause, so `[][]T`
/// (jagged), `[]*T` and `[]map[K]V` parse, bind and emit. These tests
/// build a runnable program, ilverify it, execute it and assert the runtime
/// output. The motivating case is C# `byte[][]` → G# `[][]uint8`.
///
/// Note: depth is exercised here with double-nested array literals. Triple+
/// nested array <em>literals</em> can exceed the historical fixed method
/// `maxstack` of 8 — a pre-existing engine limitation that affects any
/// deeply nested expression (e.g. `add(1, add(2, add(3, …)))`), not just
/// arrays — so it is intentionally out of scope here. Triple-nested array
/// <em>type clauses</em> (e.g. `[][][]int32` declarations) work fine.
open class Issue1046JaggedArrayEmitTests {
    @Fact
    func JaggedSliceLiteral_AllocatesReadsElements_PrintsValues() {
        // The core issue scenario: declare a jagged slice, build it from inner
        // slice literals, read its length and individual elements.
        let source = `package Test
import System
var jagged [][]int32 = [][]int32{ []int32{1, 2}, []int32{3, 4, 5} }
Console.WriteLine(jagged.Length)
Console.WriteLine(jagged[0][1])
Console.WriteLine(jagged[1][2])`
        Assert.Equal("2${Environment.NewLine}2${Environment.NewLine}5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func JaggedByteArray_TheMotivatingCsharpCase_RoundTrips() {
        // C# `byte[][]` maps to G# `[][]uint8` (DashChunkReader.cs migration).
        let source = `package Test
import System
var rows [][]uint8 = [][]uint8{ []uint8{uint8(10), uint8(20)}, []uint8{uint8(30)} }
Console.WriteLine(rows.Length)
Console.WriteLine(rows[0][1])
Console.WriteLine(rows[1][0])`
        Assert.Equal("2${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func JaggedSlice_AssignedThroughParameterAndReturn_RoundTrips() {
        // Jagged types flow through parameter and return positions.
        let source = `package Test
import System
func first(grid [][]int32) []int32 { return grid[0] }
var grid [][]int32 = [][]int32{ []int32{7, 8}, []int32{9} }
var row []int32 = first(grid)
Console.WriteLine(row[1])`
        Assert.Equal("8${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func JaggedSlice_IsPattern_SmartCast_Runs() {
        // `o is [][]uint8` smart-cast parses, binds and evaluates at runtime.
        let source = `package Test
import System
func check(o object) bool {
    return o is [][]uint8
}
var rows [][]uint8 = [][]uint8{ []uint8{uint8(1)}, []uint8{uint8(2)} }
Console.WriteLine(check(rows))`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1046_run_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let (compileExit, compileText) = RunCompiler(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileText")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                TryDeleteDirectory(tempDir)
            }
        }

        private func RunCompiler(args[]string)(Exit int32, Output string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, compileOut.ToString() + compileErr.ToString())
        }

        private func TryDeleteDirectory(dir string) {
            try {
                Directory.Delete(dir, recursive: true)
            } catch { }
        }
    }
}

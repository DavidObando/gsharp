// <copyright file="Issue1507SliceUntypedLambdaLinqEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1507 — target-typed inference of an UNTYPED arrow-lambda parameter
/// (`(i) -> …`) for a LINQ / imported extension method must work when the
/// receiver is a G# slice (`[]T`) or array (`[N]T`), matching the
/// existing `List[T]` behaviour. Before the fix the untyped lambda over a
/// slice/array receiver failed to bind (GS0159/GS0304/GS0158). These end-to-end
/// tests pin the fix at runtime: each compiles a program that runs an untyped
/// LINQ lambda over a slice/array receiver, verifies the produced IL, executes
/// it, and asserts the result.
///
/// Every type / func / package name is globally unique across the test class
/// because the process-wide `FunctionTypeSymbol` cache is not cleared
/// between in-process compilations — a reused name would alias a stale delegate
/// element symbol from another test.
open class Issue1507SliceUntypedLambdaLinqEmitTests {
    @Fact
    func Slice_UserStruct_UntypedWhereCount_Runs() {
        let source = `package P1507WhereCount
import System
import System.Linq

data struct Item1507WhereCount { var V int32 }

func Filtered(xs []Item1507WhereCount) int32 -> xs.Where((i) -> i.V > 0).Count()

let xs []Item1507WhereCount = []Item1507WhereCount{ Item1507WhereCount{V: 1}, Item1507WhereCount{V: -2}, Item1507WhereCount{V: 3} }
Console.WriteLine(Filtered(xs))`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Slice_UserStruct_UntypedSelectSum_Runs() {
        let source = `package P1507SelectSum
import System
import System.Linq

data struct Item1507SelectSum { var V int32 }

func Total(xs []Item1507SelectSum) int32 -> xs.Select((i) -> i.V).Sum()

let xs []Item1507SelectSum = []Item1507SelectSum{ Item1507SelectSum{V: 1}, Item1507SelectSum{V: -2}, Item1507SelectSum{V: 3} }
Console.WriteLine(Total(xs))`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Slice_UserStruct_ChainedWhereWhereCount_Runs() {
        let source = `package P1507Chain
import System
import System.Linq

data struct Item1507Chain { var V int32 }

func Narrowed(xs []Item1507Chain) int32 -> xs.Where((i) -> i.V > 0).Where((i) -> i.V < 3).Count()

let xs []Item1507Chain = []Item1507Chain{ Item1507Chain{V: 1}, Item1507Chain{V: 2}, Item1507Chain{V: 3}, Item1507Chain{V: -4} }
Console.WriteLine(Narrowed(xs))`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Slice_UserStruct_SelectThenWhereSum_Runs() {
        let source = `package P1507SelectWhere
import System
import System.Linq

data struct Item1507SelectWhere { var V int32 }

func Combo(xs []Item1507SelectWhere) int32 -> xs.Select((i) -> i.V).Where((v) -> v > 1).Sum()

let xs []Item1507SelectWhere = []Item1507SelectWhere{ Item1507SelectWhere{V: 1}, Item1507SelectWhere{V: 2}, Item1507SelectWhere{V: 3} }
Console.WriteLine(Combo(xs))`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Slice_PrimitiveInt32_UntypedWhereCount_Runs() {
        let source = `package P1507PrimWhere
import System
import System.Linq

func Positives(xs []int32) int32 -> xs.Where((i) -> i > 0).Count()

let xs []int32 = []int32{ 5, -1, 3, 8, -7 }
Console.WriteLine(Positives(xs))`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Slice_PrimitiveString_UntypedOrderByFirst_Runs() {
        let source = `package P1507PrimStr
import System
import System.Linq

func Shortest(xs []string) string -> xs.OrderBy((s) -> s.Length).First()

let xs []string = []string{ "apple", "kiwi", "fig" }
Console.WriteLine(Shortest(xs))`
        Assert.Equal("fig${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Array_UserStruct_UntypedWhereSelectSum_Runs() {
        let source = `package P1507ArrWhere
import System
import System.Linq

data struct Item1507ArrWhere { var V int32 }

func Positive(xs [3]Item1507ArrWhere) int32 -> xs.Where((i) -> i.V > 0).Select((i) -> i.V).Sum()

let xs [3]Item1507ArrWhere = [3]Item1507ArrWhere{ Item1507ArrWhere{V: 10}, Item1507ArrWhere{V: 20}, Item1507ArrWhere{V: -5} }
Console.WriteLine(Positive(xs))`
        Assert.Equal("30${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1507_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

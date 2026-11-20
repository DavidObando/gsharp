// <copyright file="Issue6142OrderByNestedIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #6142: end-to-end driver (gsc -> PE -> IlVerifier -> dotnet exec) tests for the FixAll
/// ordering code of ADR-0227. The 0.5.698 compiler reported only GS9998 for it. The trigger was not
/// `OrderBy(keySelector, StringComparer)` but the nested indexer followed by member access
/// (`compilation.SyntaxTrees[ranked[rank]].Text`), which the parser read as a generic type name
/// (#6071, fixed by #6121). These tests pin the whole shape, and that a wrong member on it gets a
/// real diagnostic.
open class Issue6142OrderByNestedIndexerEmitTests {
    private const Prelude string = `package Probe
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

class Text(FileName string) { }

class Tree(Text Text) { }

class Unit(Trees ImmutableArray[Tree]) { }

class Ranker {
`

    private const Main string = `}

func Main() {
    let b = Tree(Text("b.gs"))
    let a = Tree(Text("a.gs"))
    let c = Tree(Text("c.gs"))
    let unit = Unit(ImmutableArray.Create[Tree](b, a, c, a))
    let ranker = Ranker()
    let order = ranker.Rank(unit)
    Console.WriteLine(string.Join(",", order.Select((p KeyValuePair[Text, int32]) -> p.Key.FileName + "=" + p.Value.ToString())))
    Console.WriteLine(string.Join(",", ranker.RankBySelector(unit)))
}`

    @Fact
    func OrderByWithComparer_ThenNestedIndexerMemberAccess_Executes() {
        let source = Prelude + `    func Rank(unit Unit) Dictionary[Text, int32] {
        let order = Dictionary[Text, int32](ReferenceEqualityComparer.Instance)
        let names = unit.Trees.Select((t Tree) -> t.Text.FileName).ToList()
        let ranked List[int32] = Enumerable
            .Range(0, names.Count)
            .OrderBy((i int32) -> names[i], StringComparer.Ordinal)
            .ThenBy((i int32) -> i)
            .ToList()
        for var rank = 0; rank < ranked.Count; rank++ {
            let text Text = unit.Trees[ranked[rank]].Text
            if !order.ContainsKey(text) {
                order.Add(text, rank)
            }
        }
        return order
    }

    func RankBySelector(unit Unit) List[int32] -> Enumerable
        .Range(0, unit.Trees.Length)
        .OrderBy((i int32) -> unit.Trees[i].Text.FileName, StringComparer.Ordinal)
        .ThenBy((i int32) -> i)
        .ToList()
` + Main
        let output = CompileAndRun(source)
        Assert.Equal("a.gs=0,b.gs=2,c.gs=3${Environment.NewLine}1,3,0,2${Environment.NewLine}", output)
    }

    @Fact
    func OrderByWithComparer_ThenNestedIndexerWrongMember_ReportsTheMember() {
        let source = Prelude + `    func Rank(unit Unit) Dictionary[Text, int32] {
        let order = Dictionary[Text, int32](ReferenceEqualityComparer.Instance)
        let names = unit.Trees.Select((t Tree) -> t.Text.FileName).ToList()
        let ranked List[int32] = Enumerable
            .Range(0, names.Count)
            .OrderBy((i int32) -> names[i], StringComparer.Ordinal)
            .ToList()
        for var rank = 0; rank < ranked.Count; rank++ {
            let text Text = unit.Trees[ranked[rank]].Txt
            if !order.ContainsKey(text) {
                order.Add(text, rank)
            }
        }
        return order
    }

    func RankBySelector(unit Unit) List[int32] -> List[int32]()
` + Main
        let output = CompileExpectingFailure(source)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.Contains("Txt", output, StringComparison.Ordinal)
        Assert.DoesNotContain("ContainsKey", output, StringComparison.Ordinal)
    }

    shared {
        private func Compile(source string, tempDir string, out compileOutput string) int32 {
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
            compileOutput = "stdout:\n" + compileOut.ToString() + "\nstderr:\n" + compileErr.ToString()
            return compileExit
        }

        private func CompileExpectingFailure(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue6142_").FullName
            try {
                let exit = Compile(source, tempDir, out var output)
                Assert.True(exit != 0, "gsc succeeded:\n" + output)
                return output
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue6142_").FullName
            try {
                let exit = Compile(source, tempDir, out var output)
                Assert.True(exit == 0, "gsc failed:\n" + output)
                let outPath = Path.Combine(tempDir, "test.dll")
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, "exited ${proc!!.ExitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}")
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

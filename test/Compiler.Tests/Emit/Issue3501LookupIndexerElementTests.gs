// <copyright file="Issue3501LookupIndexerElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3501: an indexer whose result merely MENTIONS the receiver's type
/// parameter inside a constructed generic — `ILookup[TKey, TElement].this[TKey]`
/// returning `IEnumerable[TElement]` — fell through the bare-slot substitution
/// and used the erased closed shape, so a lookup over a same-compilation
/// element type surfaced `IEnumerable[object]` and every member read on the
/// iterated element failed GS0158 (the `byStatus[status]` shape in the
/// migrated ConstructInventory).
open class Issue3501LookupIndexerElementTests {
    @Fact
    func LookupIndexer_PreservesSourceElementType() {
        let output = CompileAndRun(`package Probe
import System
import System.Collections.Generic
import System.Linq

class Row {
    var Name string
    var Rank int32
}

func rows() List[Row] {
    let all = List[Row]()
    all.Add(Row{ Name: "a", Rank: 1 })
    all.Add(Row{ Name: "b", Rank: 2 })
    all.Add(Row{ Name: "c", Rank: 1 })
    return all
}

let byRank = rows().ToLookup((r Row) -> r.Rank)
var acc = ""
for entry in byRank[1] {
    acc = acc + entry.Name
}
for entry in byRank[2].ToList() {
    acc = acc + entry.Name
}
Console.WriteLine(acc)`)
        Assert.Equal("acb" + Environment.NewLine, output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3501_lookup_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let exitCode = RunCompiler(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath},
                    out var diagnostics
                )
                Assert.True(exitCode == 0, diagnostics)
                IlVerifier.Verify(outputPath)
                return RunAssembly(directory, outputPath)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func RunCompiler(arguments[]string, out diagnostics string) int32 {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments)
                diagnostics = (`stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
                return exitCode
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func RunAssembly(workingDirectory string, assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`dotnet exec exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}

// <copyright file="Issue1305ChainedLinqEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1305: chaining an extension/LINQ method whose generic type parameter
/// is inferred from the receiver element type (e.g. `Where`'s
/// `TSource`) over a same-compilation user element produced a constructed
/// result whose backing `ClrType` surfaced the open method type parameter
/// rather than the type-erased closed shape, so the next chained call failed to
/// bind (GS0159). These tests pin the fix end-to-end: each builds a
/// user-element collection, chains `Where(...).Select(...)` (the second
/// call's `TSource`/receiver is the first call's result), and sums the
/// projected values at runtime — proving the chained calls both bind AND emit
/// correctly. A primitive-element control guards the unchanged path.
open class Issue1305ChainedLinqEmitTests {
    // Each struct-element test uses a distinct struct name (ChWs, ChCw). These
    // emit tests share one process and compile with no explicit /reference, so
    // the (host-keyed) FunctionTypeSymbol cache for `Func<TStruct, …>` selector
    // delegates is not torn down between compilations; a shared struct name
    // would alias a prior compilation's struct symbol into the next emit.
    @Fact
    func StructElement_WhereThenSelect_SumsKept() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

struct ChWs { prop V int32 { get; init; } }

func SumKept(e IEnumerable[ChWs]) int32 {
    var total = 0
    var filtered = e.Where((c ChWs)->c.V>1).Select((c ChWs)->c.V)
    var en = filtered.GetEnumerator()
    while en.MoveNext() {
        total = total + en.Current
    }
    return total
}

var l = List[ChWs]()
l.Add(ChWs{V: 1})
l.Add(ChWs{V: 5})
l.Add(ChWs{V: 9})
Console.WriteLine(SumKept(l))`
        // Keeps V>1 → 5 + 9 = 14.
        Assert.Equal("14${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructElement_ChainedWhere_CountsKept() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

struct ChCw { prop V int32 { get; init; } }

func CountKept(e IEnumerable[ChCw]) int32 {
    var kept = e.Where((c ChCw)->c.V>0).Where((c ChCw)->c.V>3)
    var n = 0
    var en = kept.GetEnumerator()
    while en.MoveNext() {
        n = n + 1
    }
    return n
}

var l = List[ChCw]()
l.Add(ChCw{V: 1})
l.Add(ChCw{V: 5})
l.Add(ChCw{V: 9})
Console.WriteLine(CountKept(l))`
        // V>0 keeps all three; V>3 keeps 5 and 9 → 2.
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PrimitiveElement_WhereThenSelect_StillRuns() {
        // Regression control: primitive element throughout was never affected.
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

func SumKept(e IEnumerable[int32]) int32 {
    var total = 0
    var filtered = e.Where((x int32)->x>1).Select((x int32)->x*2)
    var en = filtered.GetEnumerator()
    while en.MoveNext() {
        total = total + en.Current
    }
    return total
}

var l = List[int32]()
l.Add(1)
l.Add(5)
l.Add(9)
Console.WriteLine(SumKept(l))`
        // Keeps 5,9 then doubles → 10 + 18 = 28.
        Assert.Equal("28${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1305_").FullName
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

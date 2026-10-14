// <copyright file="Issue1334DictionaryLinqReceiverErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1334 (follow-up to #1328): a `Dictionary[K, V].Values` /
/// `.Keys` collection over a same-compilation user element, when used as the
/// RECEIVER of a LINQ operator (`.Select`, `.Where`), erased the
/// projected result element to `System.Object`, so a member access on the
/// loop variable failed `GS0159`. The fix recovers the symbolic
/// `TResult` from the explicitly-annotated projection lambda while the
/// receiver supplies `TSource`. These end-to-end tests pin the fix at
/// runtime: each builds a `Dictionary[uint32, E]`, runs the value collection
/// through a LINQ operator that projects to / preserves a user element, accesses
/// the user member, executes, and asserts the result. A primitive-projection
/// control guards the closed-CLR path that always worked.
open class Issue1334DictionaryLinqReceiverErasureEmitTests {
    @Fact
    func ValuesSelect_ProjectsUserType_ForIn_YieldsUserMember() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class FilterSel(Tag uint32) { func Go() uint32 -> Tag }
data class EntrySel(FirstFilter FilterSel) {}

func ViaSelect(d Dictionary[uint32, EntrySel]) uint32 {
    var sum uint32 = 0
    for f in d.Values.Select((e EntrySel) -> e.FirstFilter) { sum = sum + f.Go() }
    return sum
}

let d = Dictionary[uint32, EntrySel]()
let k1 uint32 = 1
let k2 uint32 = 2
d.Add(k1, EntrySel(FilterSel(10)))
d.Add(k2, EntrySel(FilterSel(20)))
Console.WriteLine(ViaSelect(d))`
        Assert.Equal("30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ValuesWhere_ForIn_YieldsUserMember() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class FilterWhr(Tag uint32) { func Go() uint32 -> Tag }
data class EntryWhr(FirstFilter FilterWhr) {}

func ViaWhere(d Dictionary[uint32, EntryWhr]) uint32 {
    var sum uint32 = 0
    for e in d.Values.Where((x EntryWhr) -> true) { sum = sum + e.FirstFilter.Go() }
    return sum
}

let d = Dictionary[uint32, EntryWhr]()
let k1 uint32 = 1
let k2 uint32 = 2
d.Add(k1, EntryWhr(FilterWhr(10)))
d.Add(k2, EntryWhr(FilterWhr(20)))
Console.WriteLine(ViaWhere(d))`
        Assert.Equal("30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ValuesWhereThenSelect_Chained_ForIn_YieldsUserMember() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class FilterChn(Tag uint32) { func Go() uint32 -> Tag }
data class EntryChn(FirstFilter FilterChn) {}

func Chained(d Dictionary[uint32, EntryChn]) uint32 {
    var sum uint32 = 0
    for f in d.Values.Where((x EntryChn) -> true).Select((e EntryChn) -> e.FirstFilter) { sum = sum + f.Go() }
    return sum
}

let d = Dictionary[uint32, EntryChn]()
let k1 uint32 = 1
let k2 uint32 = 2
d.Add(k1, EntryChn(FilterChn(10)))
d.Add(k2, EntryChn(FilterChn(20)))
Console.WriteLine(Chained(d))`
        Assert.Equal("30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ValuesSelect_ThenLinqTerminal_YieldsUserMember() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class FilterTrm(Tag uint32) { func Go() uint32 -> Tag }
data class EntryTrm(FirstFilter FilterTrm) {}

func SelectFirst(d Dictionary[uint32, EntryTrm]) uint32 -> d.Values.Select((e EntryTrm) -> e.FirstFilter).First().Go()

let d = Dictionary[uint32, EntryTrm]()
let k1 uint32 = 1
d.Add(k1, EntryTrm(FilterTrm(42)))
Console.WriteLine(SelectFirst(d))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PrimitiveProjection_Control_StillWorks() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class EPrim(Value uint32) {}

func SelectPrimitive(d Dictionary[uint32, EPrim]) uint32 {
    var sum uint32 = 0
    for v in d.Values.Select((e EPrim) -> e.Value) { sum = sum + v }
    return sum
}

let d = Dictionary[uint32, EPrim]()
let k1 uint32 = 1
let k2 uint32 = 2
d.Add(k1, EPrim(5))
d.Add(k2, EPrim(9))
Console.WriteLine(SelectPrimitive(d))`
        Assert.Equal("14${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1334_").FullName
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

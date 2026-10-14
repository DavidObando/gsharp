// <copyright file="Issue1328DictionaryUserElementErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1328: enumerating a `Dictionary[K, V]` whose VALUE type
/// `V` is a same-compilation user type erased the element to
/// `System.Object` whenever the element type had to be INFERRED (foreach /
/// LINQ), so member access failed with GS0158 and assignment with GS0155. This
/// is the `Dictionary`/`ValueCollection` sibling of #1320. These
/// end-to-end tests pin the fix at runtime: each builds a
/// `Dictionary[uint32, E]`, enumerates it through the four formerly-broken
/// inference forms (`for x in d.Values`, `for kv in d`,
/// `d.Values.Single()`, `d.Values.ToList()[i]`), accesses the user
/// member, executes, and asserts the values. A primitive-value control guards
/// the path that always worked.
open class Issue1328DictionaryUserElementErasureEmitTests {
    @Fact
    func ViaValues_ForIn_YieldsUserValues() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class E(Value uint32) {}

func ViaValues(d Dictionary[uint32, E]) uint32 {
    var sum uint32 = 0
    for x in d.Values { sum = sum + x.Value }
    return sum
}

let d = Dictionary[uint32, E]()
let k1 uint32 = 1
let k2 uint32 = 2
d.Add(k1, E(10))
d.Add(k2, E(20))
Console.WriteLine(ViaValues(d))`
        Assert.Equal("30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ViaPair_ForIn_KeyValuePair_YieldsUserMembers() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class E(Value uint32) {}

func ViaPair(d Dictionary[uint32, E]) uint32 {
    var sum uint32 = 0
    for kv in d { sum = sum + kv.Key + kv.Value.Value }
    return sum
}

let d = Dictionary[uint32, E]()
let k1 uint32 = 1
d.Add(k1, E(10))
Console.WriteLine(ViaPair(d))`
        // key 1 + value 10 = 11
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func TwoVar_ForIn_Destructures_YieldsUserValue() {
        let source = `package P
import System
import System.Collections.Generic

data class E(Value uint32) {}

func TwoVar(d Dictionary[uint32, E]) uint32 {
    var sum uint32 = 0
    for k, v in d { sum = sum + k + v.Value }
    return sum
}

let d = Dictionary[uint32, E]()
let k1 uint32 = 1
d.Add(k1, E(10))
Console.WriteLine(TwoVar(d))`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ViaSingle_LinqTerminal_YieldsUserValue() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class E(Value uint32) {}

func ViaSingle(d Dictionary[uint32, E]) uint32 -> d.Values.Single().Value

let d = Dictionary[uint32, E]()
let k1 uint32 = 1
d.Add(k1, E(42))
Console.WriteLine(ViaSingle(d))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ViaToList_Indexer_YieldsUserValue() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

data class E(Value uint32) {}

func ViaToList(d Dictionary[uint32, E]) uint32 -> d.Values.ToList()[0].Value

let d = Dictionary[uint32, E]()
let k1 uint32 = 1
d.Add(k1, E(7))
Console.WriteLine(ViaToList(d))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PrimitiveValues_ForIn_Control_StillWorks() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

func PrimValues(d Dictionary[uint32, int32]) int32 {
    var sum int32 = 0
    for x in d.Values { sum = sum + x }
    return sum
}

let d = Dictionary[uint32, int32]()
let k1 uint32 = 1
let k2 uint32 = 2
d.Add(k1, 5)
d.Add(k2, 9)
Console.WriteLine(PrimValues(d))`
        Assert.Equal("14${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1328_").FullName
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

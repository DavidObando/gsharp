// <copyright file="Issue6071NestedIndexerMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #6071: end-to-end driver (gsc -> PE -> IlVerifier -> dotnet exec)
/// tests for member access, invocation, assignment, and interpolation on
/// nested indexers (`samples[jobs[slot]].Key`, `a[b[c[d]]].X`,
/// `a.b[c[d]].e`, `a[b[c]].M()`, `a[b[c]].Prop = v`,
/// `"${samples[jobs[slot]].Key}"`), alongside genuine generic static/type
/// member access controls (`Box[List[int32]].Create()`,
/// `Dictionary[string, List[int32]].Empty`,
/// `Foo[Bar[int32]].Nested.Baz`).
open class Issue6071NestedIndexerMemberEmitTests {
    @Fact
    func Repro_NestedIndexerMemberAndInterpolation_Execute() {
        let source = `package Probe
import System
import System.Collections.Generic

func Main() {
    let samples = List[KeyValuePair[string, string]]()
    samples.Add(KeyValuePair[string, string]("a", "b"))
    let jobs = List[int32]{0}
    for var slot = 0; slot < 1; slot++ {
        let direct = samples[jobs[slot]].Key
        Console.WriteLine(direct)
        Console.WriteLine("${samples[jobs[slot]].Key}")
    }
}`
        let output = CompileAndRun(source)
        Assert.Equal("a${Environment.NewLine}a${Environment.NewLine}", output)
    }

    @Fact
    func DeepNesting_MemberChain_Invocation_And_Assignment_Execute() {
        let source = `package Probe
import System
import System.Collections.Generic

class Item {
    var Prop int32
    init(p int32) { Prop = p }
    func M() int32 -> Prop + 1
}

class Holder {
    let b List[Item]
    init(items List[Item]) { b = items }
}

func Main() {
    let items = List[Item]()
    items.Add(Item(10))
    items.Add(Item(20))
    let b = List[int32]{1, 0}
    let c = List[int32]{0, 1}
    let d = 1
    let deep = items[b[c[d]]].Prop
    let holder = Holder(items)
    let chained = holder.b[c[d]].Prop
    let invoked = items[b[d]].M()
    let parenthesized = items[(b[d])].Prop
    items[b[d]].Prop = 99
    items[b[d]].Prop += 1
    let updated = items[b[d]].Prop
    Console.WriteLine("${deep}:${chained}:${invoked}:${parenthesized}:${updated}")
}`
        let output = CompileAndRun(source)
        Assert.Equal("10:20:11:10:100${Environment.NewLine}", output)
    }

    @Fact
    func GenuineGenericStaticMemberControls_Execute() {
        let source = `package Probe
import System
import System.Collections.Generic
import System.Collections.Immutable

class Box[T] {
    shared { func Create() int32 -> 7 }
}

class Bar[T] {}

class Foo[T] {
    class Nested {
        shared { let Baz int32 = 19 }
    }
}

class Outer[T] {
    class Inner {
        shared { let Value int32 = 5 }
    }
}

func Main() {
    let created = Box[List[int32]].Create()
    let emptyCount = ImmutableDictionary[string, List[int32]].Empty.Count
    let nested = Foo[Bar[int32]].Nested.Baz
    let perSeg = Box[Outer[int32].Inner].Create()
    Console.WriteLine("${created}:${emptyCount}:${nested}:${perSeg}")
}`
        let output = CompileAndRun(source)
        Assert.Equal("7:0:19:7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue6071_").FullName
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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

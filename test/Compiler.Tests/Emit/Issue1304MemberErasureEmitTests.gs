// <copyright file="Issue1304MemberErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1304: accessing a property/member on a constructed BCL/generic type
/// instantiated over a same-compilation user type (e.g.
/// `IEnumerator[Ch].Current`) erased the member type to `object`
/// instead of substituting the user element `Ch`. These tests pin the fix
/// end-to-end: each enumerates a user-element collection and reads
/// `.Current.<member>`, summing the member values at runtime — proving
/// the member type both binds AND emits correctly over a user element. A
/// primitive-element control guards the unchanged path.
open class Issue1304MemberErasureEmitTests {
    @Fact
    func StructElementEnumerator_ReadCurrentMember_Sums() {
        let source = `package P
import System
import System.Collections.Generic

struct Ch { prop V int32 { get; init; } }

func GetE(l List[Ch]) IEnumerator[Ch] { return l.GetEnumerator() }

func SumV(e IEnumerator[Ch]) int32 {
    var total = 0
    while e.MoveNext() {
        total = total + e.Current.V
    }
    return total
}

var l = List[Ch]()
l.Add(Ch{V: 5})
l.Add(Ch{V: 7})
l.Add(Ch{V: 9})
Console.WriteLine(SumV(GetE(l)))`
        Assert.Equal("21${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructElementEnumerator_ReturnCurrentElement_Roundtrips() {
        let source = `package P
import System
import System.Collections.Generic

struct Ch { prop V int32 { get; init; } }

func GetE(l List[Ch]) IEnumerator[Ch] { return l.GetEnumerator() }

func First(e IEnumerator[Ch]) Ch {
    e.MoveNext()
    return e.Current
}

var l = List[Ch]()
l.Add(Ch{V: 42})
l.Add(Ch{V: 7})
var c = First(GetE(l))
Console.WriteLine(c.V)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ClassElementEnumerator_ReadCurrentMember_Sums() {
        let source = `package P
import System
import System.Collections.Generic

class Seg { public var X int32 = 0 }

func GetE(l List[Seg]) IEnumerator[Seg] { return l.GetEnumerator() }

func SumX(e IEnumerator[Seg]) int32 {
    var total = 0
    while e.MoveNext() {
        total = total + e.Current.X
    }
    return total
}

var a = Seg()
a.X = 3
var b = Seg()
b.X = 4
var l = List[Seg]()
l.Add(a)
l.Add(b)
Console.WriteLine(SumX(GetE(l)))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PrimitiveElementEnumerator_ReadCurrent_StillWorks() {
        // Regression control: the primitive (IEnumerator[int32]) path is
        // unchanged.
        let source = `package P
import System
import System.Collections.Generic

func GetE(l List[int32]) IEnumerator[int32] { return l.GetEnumerator() }

func Sum(e IEnumerator[int32]) int32 {
    var total = 0
    while e.MoveNext() {
        total = total + e.Current
    }
    return total
}

var l = List[int32]()
l.Add(1)
l.Add(2)
l.Add(3)
Console.WriteLine(Sum(GetE(l)))`
        Assert.Equal("6${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1304_").FullName
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

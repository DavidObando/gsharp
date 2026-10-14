// <copyright file="Issue1302EnumeratorInterfaceUserElementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1302: converting a constructed BCL value struct
/// (`List[T].Enumerator`) to its generic interface
/// (`IEnumerator[T]`) failed with GS0155 when the element type `T`
/// was a same-compilation user type, because the implemented-interface set was
/// compared against the target by erased CLR identity (a user element symbol
/// has a null `ClrType` during binding) instead of structurally over the
/// substituted element type. These tests pin the fix end-to-end: each returns
/// `list.GetEnumerator()` as an `IEnumerator[UserStruct]`, then drives
/// the converted enumerator at runtime and asserts the number of elements it
/// yields — proving the boxing conversion both binds AND emits a runtime-correct
/// enumerator. A `List[int32]` control guards the primitive path.
open class Issue1302EnumeratorInterfaceUserElementEmitTests {
    @Fact
    func StructElementList_EnumeratorToInterface_Iterates() {
        let source = `package P
import System
import System.Collections.Generic

struct Ch { prop V int32 { get; init; } }

func F(l List[Ch]) IEnumerator[Ch] { return l.GetEnumerator() }

var l = List[Ch]()
l.Add(Ch{V: 5})
l.Add(Ch{V: 7})
l.Add(Ch{V: 9})
var e = F(l)
var n = 0
while e.MoveNext() {
    n = n + 1
}
Console.WriteLine(n)`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ClassElementList_EnumeratorToInterface_Iterates() {
        let source = `package P
import System
import System.Collections.Generic

class Seg { public var X int32 = 0 }

func F(l List[Seg]) IEnumerator[Seg] { return l.GetEnumerator() }

var a = Seg()
var b = Seg()
var l = List[Seg]()
l.Add(a)
l.Add(b)
var e = F(l)
var n = 0
while e.MoveNext() {
    n = n + 1
}
Console.WriteLine(n)`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DataStructElementList_EnumeratorToInterface_Iterates() {
        let source = `package P
import System
import System.Collections.Generic

data struct Point { var X int32
                    var Y int32 }

func F(l List[Point]) IEnumerator[Point] { return l.GetEnumerator() }

var l = List[Point]()
l.Add(Point{X: 1, Y: 2})
l.Add(Point{X: 3, Y: 4})
l.Add(Point{X: 5, Y: 6})
l.Add(Point{X: 7, Y: 8})
var e = F(l)
var n = 0
while e.MoveNext() {
    n = n + 1
}
Console.WriteLine(n)`
        Assert.Equal("4${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PrimitiveElementList_EnumeratorToInterface_StillWorks() {
        // Regression control: the primitive (List[int32]) path is unchanged.
        let source = `package P
import System
import System.Collections.Generic

func F(l List[int32]) IEnumerator[int32] { return l.GetEnumerator() }

var l = List[int32]()
l.Add(1)
l.Add(2)
l.Add(3)
var e = F(l)
var sum = 0
while e.MoveNext() {
    sum = sum + e.Current
}
Console.WriteLine(sum)`
        Assert.Equal("6${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        // The struct case prints the iteration count over a three-element list,
        // proving the converted IEnumerator[Ch] yields every element at runtime.
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1302_").FullName
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

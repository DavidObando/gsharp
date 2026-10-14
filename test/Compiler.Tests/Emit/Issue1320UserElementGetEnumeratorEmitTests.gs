// <copyright file="Issue1320UserElementGetEnumeratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1320: `GetEnumerator()` on a `sequence[UserType]` (an
/// iterator return type, alias for `IEnumerable<UserType>`) failed to
/// bind with GS0159, while it resolved for a primitive element and for an
/// explicitly-typed `IEnumerable[UserType]`. These end-to-end tests pin the
/// fix at runtime: each drives the bridged `SeqUser().GetEnumerator()` via
/// `MoveNext()` / `Current` and asserts the user values it yields,
/// proving the generic `IEnumerator[UserType]` overload both binds AND emits
/// a runtime-correct enumerator. A `sequence[int32]` control guards the
/// primitive path.
open class Issue1320UserElementGetEnumeratorEmitTests {
    @Fact
    func StructSequence_GetEnumerator_YieldsUserValues() {
        let source = `package P
import System
import System.Collections.Generic

struct E { var X int32 }

func SeqUser() sequence[E] {
    yield E{X: 10}
    yield E{X: 20}
    yield E{X: 30}
}

func Sum() int32 {
    var e = SeqUser().GetEnumerator()
    var sum = 0
    while e.MoveNext() {
        sum = sum + e.Current.X
    }
    return sum
}

Console.WriteLine(Sum())`
        Assert.Equal("60${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ClassSequence_GetEnumerator_YieldsUserValues() {
        let source = `package P
import System
import System.Collections.Generic

class Seg { public var X int32 = 0 }

func MakeSeg(v int32) Seg {
    var s = Seg()
    s.X = v
    return s
}

func SeqUser() sequence[Seg] {
    yield MakeSeg(1)
    yield MakeSeg(2)
}

func Count() int32 {
    var e = SeqUser().GetEnumerator()
    var n = 0
    while e.MoveNext() {
        n = n + e.Current.X
    }
    return n
}

Console.WriteLine(Count())`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PrimitiveSequence_GetEnumerator_StillWorks() {
        // Regression control: the primitive (sequence[int32]) path is unchanged.
        let source = `package P
import System
import System.Collections.Generic

func SeqPrim() sequence[int32] {
    yield 1
    yield 2
    yield 3
}

func Sum() int32 {
    var e = SeqPrim().GetEnumerator()
    var sum = 0
    while e.MoveNext() {
        sum = sum + e.Current
    }
    return sum
}

Console.WriteLine(Sum())`
        Assert.Equal("6${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1320_").FullName
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

// <copyright file="Issue709NullCoalescingAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #709 / ADR-0072 — emit coverage for the new `??=`
/// null-coalescing compound assignment statement. Each test compiles via
/// in-process `gsc`, IL-verifies the emitted PE, and runs it under
/// `dotnet exec`, asserting captured stdout.
open class Issue709NullCoalescingAssignmentEmitTests {
    @Fact
    func Local_NullableString_WritesWhenNil_PreservesWhenNonNil() {
        let source = `package Test
import System

func main() {
    var x string? = nil
    x ??= "first"
    Console.WriteLine(x)
    x ??= "second"
    Console.WriteLine(x)
}

main()`
        Assert.Equal("first${Environment.NewLine}first${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Local_NullableInt32_WritesWhenNil_PreservesWhenNonNil() {
        let source = `package Test
import System

func main() {
    var n int32? = nil
    n ??= 42
    Console.WriteLine(n)
    n ??= 99
    Console.WriteLine(n)
}

main()`
        Assert.Equal("42${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Field_LHS_WritesThroughClassReceiver() {
        let source = `package Test
import System

class Box {
    var Name string?
}

func main() {
    var b = Box{Name: nil}
    b.Name ??= "set"
    Console.WriteLine(b.Name)
    b.Name ??= "ignored"
    Console.WriteLine(b.Name)
}

main()`
        Assert.Equal("set${Environment.NewLine}set${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Property_LHS_WritesThroughAutoProperty() {
        let source = `package Test
import System

class Person {
    prop Name string?
}

func main() {
    var p = Person{}
    p.Name ??= "Alice"
    Console.WriteLine(p.Name)
    p.Name ??= "Bob"
    Console.WriteLine(p.Name)
}

main()`
        Assert.Equal("Alice${Environment.NewLine}Alice${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Map_IndexerLHS_WritesWhenNil() {
        let source = `package Test
import System

func main() {
    var m = map[string,string?]{}
    m["k"] = nil
    m["k"] ??= "v"
    Console.WriteLine(m["k"])
    m["k"] ??= "ignored"
    Console.WriteLine(m["k"])
}

main()`
        Assert.Equal("v${Environment.NewLine}v${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Receiver_EvaluatedOnce_RhsOnlyWhenNil() {
        // The receiver function is called once per `??=` regardless of
        // whether the write fires. The RHS function is called only when
        // the current value is nil — single-evaluation guarantee.
        let source = `package Test
import System

class Box {
    var Name string?
}

var receiverCalls int32 = 0
var rhsCalls int32 = 0

func getBox(b Box) Box {
    receiverCalls = receiverCalls + 1
    return b
}

func computeRhs() string {
    rhsCalls = rhsCalls + 1
    return "v"
}

func main() {
    var b = Box{Name: nil}

    getBox(b).Name ??= computeRhs()
    Console.WriteLine(receiverCalls)
    Console.WriteLine(rhsCalls)
    Console.WriteLine(b.Name)

    getBox(b).Name ??= computeRhs()
    Console.WriteLine(receiverCalls)
    Console.WriteLine(rhsCalls)
    Console.WriteLine(b.Name)
}

main()`
        // First call: receiver=1, rhs=1 (Name was nil), b.Name=v.
        // Second call: receiver=2 (called again), rhs still 1 (b.Name is
        // no longer nil so RHS is short-circuited), b.Name still v.
        Assert.Equal(
            "1${Environment.NewLine}1${Environment.NewLine}v${Environment.NewLine}2${Environment.NewLine}1${Environment.NewLine}v${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue709_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
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
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
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

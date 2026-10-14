// <copyright file="Issue1212NullableElementArrayIndexEmitTests.cs" company="GSharp">
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

/// Issue #1212 — emit/execution coverage for indexing an array/slice whose
/// element type is nullable (`[]T?`). Each test compiles via in-process
/// `gsc`, IL-verifies the emitted PE, and runs it under `dotnet exec`,
/// asserting captured stdout. Both a nullable *value*-element array
/// (`[]int32?`, backed by `Nullable<int32>[]`) and a nullable
/// *reference*-element array (`[]object?`, backed by `object[]`) are
/// written (including a nil and a value) and read back, proving the emitted
/// `ldelem`/`stelem` round-trip the nullable element correctly. A
/// nullable array reference (`[]?int32`) is also exercised through the
/// null-forgiving `!!` path.
open class Issue1212NullableElementArrayIndexEmitTests {
    @Fact
    func NullableValueElementSlice_WriteReadRoundTrips() {
        let source = `package Test
import System

func main() {
    var a []int32? = []int32?{nil, 7, nil}
    a[0] = 42
    if a[0] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[0]!!) }
    if a[1] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[1]!!) }
    if a[2] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[2]!!) }
}

main()`
        Assert.Equal("42${Environment.NewLine}7${Environment.NewLine}nil${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NullableReferenceElementSlice_WriteReadRoundTrips() {
        let source = `package Test
import System

func main() {
    var a []object? = []object?{nil, "hi"}
    a[0] = "set"
    if a[0] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[0]!!) }
    if a[1] == nil { Console.WriteLine("nil") } else { Console.WriteLine(a[1]!!) }
}

main()`
        Assert.Equal("set${Environment.NewLine}hi${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NullableValueElementSlice_WriteNil_ReadsBackNil() {
        let source = `package Test
import System

func main() {
    var a []int32? = []int32?{1, 2, 3}
    a[1] = nil
    Console.WriteLine(a.Length)
    if a[1] == nil {
        Console.WriteLine("cleared")
    } else {
        Console.WriteLine("kept")
    }
    Console.WriteLine(a[2]!!)
}

main()`
        Assert.Equal(
            "3${Environment.NewLine}cleared${Environment.NewLine}3${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NullableArrayReference_IndexableAfterNullForgiving() {
        // `[]?int32` is a nullable array reference: it can hold nil and must be
        // null-forgiven (`!!`) before indexing.
        let source = `package Test
import System

func main() {
    var a []?int32 = nil
    if a == nil { Console.WriteLine("nil-array") }
    a = []int32{10, 20, 30}
    Console.WriteLine(a!![1])
}

main()`
        Assert.Equal("nil-array${Environment.NewLine}20${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1212_").FullName
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

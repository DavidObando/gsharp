// <copyright file="Issue774OpenReceiverIterationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #774 follow-up: end-to-end emit + IL-verify coverage for
/// iterating an open-generic receiver via `for v in self`. Pre-fix
/// the binder rejected these programs with `GS0155`; this suite
/// validates that the produced assembly is IL-verifiable and runs to
/// the expected stdout.
open class Issue774OpenReceiverIterationEmitTests {
    @Fact
    func IEnumerableT_Receiver_ForIn_Returns_First_Element_As_T() {
        // Issue repro shape: iterate the open receiver, return the
        // first element typed as T. Pre-fix this failed to bind.
        let source = `package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T any](fb T) T {
    for v in self {
        return v
    }
    return fb
}

var arr = []int32{10, 20, 30}
Console.WriteLine(arr.MyFirst(0))`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}", output)
    }

    @Fact
    func IEnumerableT_Receiver_ForIn_Counts_Elements() {
        let source = `package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) MyCount[T](seed T) int32 {
    var n = 0
    for v in self {
        n = n + 1
    }
    return n
}

var arr = []string{"a", "b", "c", "d"}
Console.WriteLine(arr.MyCount(""))`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    @Fact
    func SequenceT_Receiver_ForIn_Forwards_Element_As_T() {
        let source = `package P
import System

func passthrough[T](x T) T {
    return x
}

func (self sequence[T]) FirstOr[T](fb T) T {
    for v in self {
        return passthrough(v)
    }
    return fb
}

var arr = []int32{42, 99}
Console.WriteLine(arr.FirstOr(0))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func SliceT_Receiver_ForIn_Returns_First_Element() {
        let source = `package P
import System

func (self []T) Head[T](fb T) T {
    for v in self {
        return v
    }
    return fb
}

var arr = []int32{7, 8, 9}
Console.WriteLine(arr.Head(0))`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func IEnumerableT_Receiver_ForIn_Roundtrips_StringElement() {
        // Body returns the iteration variable as T to a string callsite.
        let source = `package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T](fb T) T {
    for v in self {
        return v
    }
    return fb
}

var arr = []string{"hello", "world"}
Console.WriteLine(arr.MyFirst(""))`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func DictionaryKV_Receiver_ForIn_Returns_First_Key_And_Value() {
        // `for k, v in self` over `Dictionary[K, V]` must surface k as
        // K and v as V. Pre-fix the binder erased both to object;
        // post-fix the emit path lowers them through the KeyValuePair
        // pair-projection and IL-verifies clean.
        let source = `package P
import System
import System.Collections.Generic

func (self Dictionary[K, V]) FirstValueOr[K, V](fb V) V {
    for k, v in self {
        return v
    }
    return fb
}

var d = Dictionary[string, int32]()
d["a"] = 100
Console.WriteLine(d.FirstValueOr(0))`
        let output = CompileAndRun(source)
        Assert.Equal("100${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue774_emit_").FullName
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

// <copyright file="Issue773GenericReceiverExtensionEmitTests.cs" company="GSharp">
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

/// Issue #773 / ADR-0084 §L2 follow-up. End-to-end emit + IL-verify
/// coverage for user-defined extension methods whose receiver type
/// carries a function-level type parameter. The pre-fix binder reported
/// GS0159 "Cannot find function" for every call site below; after the
/// fix the binder finds the candidate via receiver unification, the
/// emitter lowers the call through the existing type-erased generic
/// path, and `ilverify` accepts the produced IL.
open class Issue773GenericReceiverExtensionEmitTests {
    @Fact
    func IEnumerableT_Extension_Dispatches_Int32Slice_Repro() {
        let source = `package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T any](fb T) T {
    return fb
}

var arr = []int32{10, 20, 30}
Console.WriteLine(arr.MyFirst(99))`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func SequenceT_HeadOr_Dispatches_Int32Slice() {
        let source = `package P
import System

func (self sequence[T]) HeadOr[T](fb T) T {
    return fb
}

var arr = []int32{1, 2, 3}
Console.WriteLine(arr.HeadOr(7))`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func SequenceT_HeadOr_Dispatches_StringSlice() {
        let source = `package P
import System

func (self sequence[T]) HeadOr[T](fb T) T {
    return fb
}

var arr = []string{"a", "b"}
Console.WriteLine(arr.HeadOr("z"))`
        let output = CompileAndRun(source)
        Assert.Equal("z${Environment.NewLine}", output)
    }

    @Fact
    func NullableReceiver_Extension_Dispatches_OnStringNullable_NoBodyNullCheck() {
        // The dispatch path (binder + emit) works for `(self T?)` over
        // a reference-typed nullable. The body intentionally avoids
        // comparing an open `T` against `nil` — that pattern stays in
        // the binding-focused Core.Tests coverage; the end-to-end emit gap
        // for it is tracked as a follow-up to this issue.
        let source = `package P
import System

func (self T?) AlwaysFallback[T](fb T) T {
    return fb
}

var s string? = nil
Console.WriteLine(s.AlwaysFallback("def"))`
        let output = CompileAndRun(source)
        Assert.Equal("def${Environment.NewLine}", output)
    }

    @Fact
    func DictionaryReceiver_TwoTypeParameters_Dispatches() {
        let source = `package P
import System
import System.Collections.Generic

func (self Dictionary[K, V]) MyCount[K, V]() int32 {
    return 42
}

var d = Dictionary[string, int32]()
Console.WriteLine(d.MyCount())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func SliceT_Extension_Dispatches_OnInt32Slice() {
        let source = `package P
import System

func (self []T) FirstOr[T](fb T) T {
    return fb
}

var a = []int32{1, 2, 3}
Console.WriteLine(a.FirstOr(99))`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue773_emit_").FullName
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

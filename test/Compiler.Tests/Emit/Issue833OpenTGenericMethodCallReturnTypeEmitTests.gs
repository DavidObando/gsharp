// <copyright file="Issue833OpenTGenericMethodCallReturnTypeEmitTests.cs" company="GSharp">
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

/// Issue #833 end-to-end coverage. The binder + emitter fix re-projects
/// open method type parameters (MVar) through the return type of
/// imported generic-method calls (e.g. `Enumerable.Empty[T]()`,
/// `Array.Empty[T]()`, `[]T{}.ToArray()`). These tests
/// round-trip each scenario through compile → IL-verify → run so we
/// catch any emit-time regression in the MethodSpec encoding (ADR-0087
/// F1 / parent #706).
open class Issue833OpenTGenericMethodCallReturnTypeEmitTests {
    @Fact
    func EnumerableEmpty_With_OpenT_Roundtrips_Int32() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

class Sequences {
    shared {
        func Empty[T]() IEnumerable[T] {
            return Enumerable.Empty[T]()
        }
    }
}

var seq = Sequences.Empty[int32]()
var count = 0
for v in seq {
    count = count + 1
}
Console.WriteLine(count)
Console.WriteLine("done")`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}done${Environment.NewLine}", output)
    }

    @Fact
    func EnumerableEmpty_With_OpenT_Roundtrips_String() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

func Empty[T]() IEnumerable[T] {
    return Enumerable.Empty[T]()
}

var seq = Empty[string]()
var count = 0
for v in seq {
    count = count + 1
}
Console.WriteLine(count)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func ArrayEmpty_With_OpenT_Returns_SliceOfT_Roundtrips_Int32() {
        let source = `package P
import System

class Sequences {
    shared {
        func Empty[T]() []T {
            return Array.Empty[T]()
        }
    }
}

var arr = Sequences.Empty[int32]()
Console.WriteLine(arr.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func ToArray_On_OpenT_Slice_Returns_SliceOfT_Roundtrips() {
        let source = `package P
import System
import System.Linq

func MakeEmpty[T]() []T {
    return []T{}.ToArray()
}

var arr = MakeEmpty[int32]()
Console.WriteLine(arr.Length)
var arrS = MakeEmpty[string]()
Console.WriteLine(arrS.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func EnumerableRepeat_With_OpenT_Roundtrips_Value() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

func Repeat[T](v T, n int32) IEnumerable[T] {
    return Enumerable.Repeat[T](v, n)
}

var seq = Repeat[int32](42, 3)
for v in seq {
    Console.WriteLine(v)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func EnumerableEmpty_Inside_Generic_Extension_Method_Roundtrips() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

func (self []T) ReplaceWithEmpty[T]() IEnumerable[T] {
    return Enumerable.Empty[T]()
}

var arr = []int32{1, 2, 3}
var seq = arr.ReplaceWithEmpty()
var count = 0
for v in seq {
    count = count + 1
}
Console.WriteLine(count)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue833_emit_").FullName
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

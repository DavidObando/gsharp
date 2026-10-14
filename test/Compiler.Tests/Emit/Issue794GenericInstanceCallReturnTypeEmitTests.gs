// <copyright file="Issue794GenericInstanceCallReturnTypeEmitTests.cs" company="GSharp">
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

/// Issue #794 end-to-end coverage. The binder fix re-projects the
/// receiver's symbolic type arguments through instance calls and
/// property reads on imported CLR generics. These tests round-trip
/// each scenario through compile → IL-verify → run so we catch any
/// emit-time regression in the type-erased generic dispatch path
/// (ADR-0087 R1–R5 / #313 / #671 / #765).
open class Issue794GenericInstanceCallReturnTypeEmitTests {
    @Fact
    func ListT_ToArray_From_Generic_Shared_Roundtrips_Int32() {
        let source = `package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func MakeList[T any](v T) []T {
            var list = List[T]()
            list.Add(v)
            list.Add(v)
            return list.ToArray()
        }
    }
}

var arr = Sequences.MakeList[int32](42)
Console.WriteLine(arr.Length)
Console.WriteLine(arr[0])
Console.WriteLine(arr[1])`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func ListT_ToArray_From_Generic_Shared_Roundtrips_String() {
        let source = `package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func MakeList[T any](v T) []T {
            var list = List[T]()
            list.Add(v)
            return list.ToArray()
        }
    }
}

var arr = Sequences.MakeList[string]("hi")
Console.WriteLine(arr.Length)
Console.WriteLine(arr[0])`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func ListT_Count_From_Generic_Shared_Returns_Int32() {
        let source = `package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func CountThree[T any](v T) int32 {
            var list = List[T]()
            list.Add(v)
            list.Add(v)
            list.Add(v)
            return list.Count
        }
    }
}

Console.WriteLine(Sequences.CountThree[int32](0))
Console.WriteLine(Sequences.CountThree[string](""))`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func ListT_Add_With_TypeParameter_Argument_Inside_Generic_TopLevel_Func() {
        let source = `package P
import System
import System.Collections.Generic

func MakeAndCount[T any](a T, b T) int32 {
    var list = List[T]()
    list.Add(a)
    list.Add(b)
    return list.Count
}

Console.WriteLine(MakeAndCount[int32](1, 2))
Console.WriteLine(MakeAndCount[string]("x", "y"))`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func DictionaryKV_Keys_Iterated_Returns_K() {
        let source = `package P
import System
import System.Collections.Generic

class Helper {
    shared {
        func FirstOrFallback[K any, V any](fb K, seed V) K {
            var dict = Dictionary[K, V]()
            dict.Add(fb, seed)
            for k in dict.Keys {
                return k
            }
            return fb
        }
    }
}

Console.WriteLine(Helper.FirstOrFallback[string, int32]("fallback", 0))
Console.WriteLine(Helper.FirstOrFallback[int32, string](-1, ""))`
        let output = CompileAndRun(source)
        Assert.Equal("fallback${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func Generic_Extension_Method_With_ListT_ToArray_Roundtrip() {
        // Cross-check #773: an extension whose receiver is `[]T` calls
        // through to `List[T]().ToArray()` and must thread the same `T`.
        let source = `package P
import System
import System.Collections.Generic

func (self []T) DoubleViaList[T]() []T {
    var list = List[T]()
    for v in self {
        list.Add(v)
        list.Add(v)
    }
    return list.ToArray()
}

var arr = []int32{1, 2}
var doubled = arr.DoubleViaList()
Console.WriteLine(doubled.Length)
Console.WriteLine(doubled[0])
Console.WriteLine(doubled[3])`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func Generic_TypeParameter_ToInterface_And_ListT_Add_EmitsValidIl_Roundtrip() {
        // Regression guard for the issue #1196 conversion change: classifying
        // `T -> interface` as an implicit conversion must NOT spill over to
        // `T -> object`. Open generic parameter slots (e.g. the `!0` element
        // type of `List[T].Add(!0)`) are erased to the `object` singleton, so a
        // `T -> object` rule made the emitter inject a spurious `box T` before
        // the call, producing invalid IL (System.InvalidProgramException at
        // runtime). This test exercises BOTH a genuine `T -> interface`
        // conversion (which must still box + dispatch correctly) AND a generic
        // method that adds a type-parameter value into a `List[T]` (which must
        // pass `T` straight through with no box). `IlVerifier.Verify` inside
        // `CompileAndRun` fails the test if either path emits invalid IL.
        let source = `package P
import System
import System.Collections.Generic

interface IPrim {
    func V() int32;
}

class RefBox(N int32) : IPrim {
    func V() int32 {
        return N
    }
}

func Use[T IPrim](t T) IPrim {
    var x IPrim = t
    return x
}

func (self []T) DoubleViaList[T]() []T {
    var list = List[T]()
    for v in self {
        list.Add(v)
        list.Add(v)
    }
    return list.ToArray()
}

var doubled = []int32{5}.DoubleViaList()
Console.WriteLine(Use(RefBox(9)).V())
Console.WriteLine(doubled.Length)
Console.WriteLine(doubled[1])`
        let output = CompileAndRun(source)
        Assert.Equal("9${Environment.NewLine}2${Environment.NewLine}5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue794_emit_").FullName
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

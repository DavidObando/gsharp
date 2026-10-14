// <copyright file="Issue1572UserValueTypeNullableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #1572: user-declared value-type nullables (`struct?` / `enum?`)
/// must emit verifiable IL for the nil-default, lift, `(v!!)` unwrap, and
/// `(v!!).Member` operations, plus the `if v != nil { ... }` narrowing
/// (issue #1547) that reuses the same unwrap machinery. In-flight user value
/// types have a null CLR (cref:Type) during emit, so the detector must be
/// symbol-aware (`StructSymbol` with `!IsClass`, or `EnumSymbol`)
/// and the emitter must close `System.Nullable`1` over the emitted
/// TypeDef/TypeSpec rather than a host `Type`.
///
/// Each test compiles via `gsc`, IL-verifies the produced PE, then executes
/// it under `dotnet exec` and asserts on captured stdout. Every user
/// struct/enum/package is given a UNIQUE name because the in-process
/// name-keyed `FunctionTypeSymbol` cache is not cleared between tests.
open class Issue1572UserValueTypeNullableEmitTests {
    @Fact
    func StructNilDefault_EmitsVerifiableInitobj() {
        let source = `package NilDefaultPkg

import System

struct PtA { var x int32 }

func MakeNil() PtA? { return nil }

let v = MakeNil()
Console.WriteLine(v == nil)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructLift_EmitsNewobjNullableCtor() {
        let source = `package LiftPkg

import System

struct PtB { var x int32 }

func Lift() PtB? {
    let p = PtB{x: 7}
    return p
}

let v = Lift()
Console.WriteLine((v!!).x)`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructBang_UnwrapsViaGetValue() {
        let source = `package BangPkg

import System

struct PtC { var x int32 }

func Unwrap(v PtC?) PtC { return v!! }

let p = PtC{x: 42}
let r = Unwrap(p)
Console.WriteLine(r.x)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructBangMember_ReadsFieldOffUnwrappedValue() {
        let source = `package BangMemberPkg

import System

struct PtD { var x int32 }

func GetX(v PtD?) int32 { return (v!!).x }

let p = PtD{x: 99}
Console.WriteLine(GetX(p))`
        Assert.Equal("99${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EnumBang_UnwrapsViaGetValue() {
        let source = `package EnumBangPkg

import System

enum ColorA { Red, Green, Blue }

func Unwrap(v ColorA?) ColorA { return v!! }

let c ColorA? = ColorA.Green
let r = Unwrap(c)
Console.WriteLine(r == ColorA.Green)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EnumNilDefault_EmitsVerifiableInitobj() {
        let source = `package EnumNilPkg

import System

enum ColorB { Red, Green }

func MakeNil() ColorB? { return nil }

let v = MakeNil()
Console.WriteLine(v == nil)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructNarrowing_IfNotNil_ReadsUnwrappedValue() {
        let source = `package NarrowStructPkg

import System

struct PtE { var x int32 }

func Describe(v PtE?) int32 {
    if v != nil {
        return v.x
    }
    return -1
}

let p = PtE{x: 5}
let none PtE? = nil
Console.WriteLine(Describe(p))
Console.WriteLine(Describe(none))`
        Assert.Equal("5${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EnumNarrowing_IfNotNil_ReadsUnwrappedValue() {
        let source = `package NarrowEnumPkg

import System

enum ColorC { Red, Green, Blue }

func Pick(v ColorC?) ColorC {
    if v != nil {
        return v
    }
    return ColorC.Red
}

let c ColorC? = ColorC.Blue
let none ColorC? = nil
Console.WriteLine(Pick(c) == ColorC.Blue)
Console.WriteLine(Pick(none) == ColorC.Red)`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func MultiFieldStruct_LiftUnwrapAndMemberAllVerify() {
        let source = `package MultiFieldPkg

import System

struct Rec {
    var a int32
    var b string
    var c bool
}

func Lift() Rec? {
    let r = Rec{a: 1, b: "hi", c: true}
    return r
}

func GetB(v Rec?) string { return (v!!).b }

let lifted = Lift()
Console.WriteLine((lifted!!).a)
Console.WriteLine(GetB(lifted))`
        Assert.Equal("1${Environment.NewLine}hi${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructWithReferenceField_UnwrapReadsReferenceMember() {
        let source = `package RefFieldPkg

import System

struct Named {
    var name string
    var count int32
}

func GetName(v Named?) string { return (v!!).name }

let n = Named{name: "widget", count: 3}
Console.WriteLine(GetName(n))`
        Assert.Equal("widget${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EmptyStruct_NilDefaultAndUnwrapVerify() {
        let source = `package EmptyStructPkg

import System

struct Unit {}

func MakeNil() Unit? { return nil }
func Unwrap(v Unit?) Unit { return v!! }

let some Unit? = Unit{}
let unwrapped = Unwrap(some)
Console.WriteLine(MakeNil() == nil)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ArgumentLift_NonNullableStructPassedToNullableParameter() {
        let source = `package ArgLiftPkg

import System

struct PtF { var x int32 }

func Take(v PtF?) int32 { return (v!!).x }

let p = PtF{x: 21}
Console.WriteLine(Take(p))`
        Assert.Equal("21${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NullableStructField_UnwrapReadsNestedMember() {
        let source = `package NestedFieldPkg

import System

struct Inner { var v int32 }

struct Outer {
    var opt Inner?
}

func Read(o Outer) int32 { return (o.opt!!).v }

let o = Outer{opt: Inner{v: 8}}
Console.WriteLine(Read(o))`
        Assert.Equal("8${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1572_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
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
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}

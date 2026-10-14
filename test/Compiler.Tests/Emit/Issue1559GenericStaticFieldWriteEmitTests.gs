// <copyright file="Issue1559GenericStaticFieldWriteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1559 — assigning to a STATIC FIELD of a CONSTRUCTED GENERIC TYPE
/// through a qualified receiver (`Type[T].staticField = value`) failed to
/// bind: the assignment-target binder treated the type receiver as a variable
/// and reported `GS0125 Variable 'Type' doesn't exist` (plus one GS0125 per
/// type argument). READING the same field worked, and WRITING a NON-generic
/// static field worked; only the constructed-generic type receiver on an
/// assignment target was broken.
///
/// The fix routes the assignment-target binder (simple `=`, compound
/// `+=`, and the `++`/`--` desugar) through the same
/// constructed-generic-type receiver resolution the READ path uses, so
/// `G[T1..Tn].staticMember = value` binds against the constructed TYPE and
/// emits a store parented at the correct `TypeSpec`. Covers both parser
/// receiver shapes (index-expression `Foo[T]` and generic-name
/// `Foo[int32?]`/`Pair[A, B]`), static fields, static property setters,
/// and multiple / nullable / nested type arguments.
///
/// Each test uses a UNIQUE package and type name because the in-process type /
/// FunctionTypeSymbol caches are name-keyed; reused names cause cross-test
/// contamination.
open class Issue1559GenericStaticFieldWriteEmitTests {
    @Fact
    func EndToEnd_WriteThenRead_GenericStaticField_Runs() {
        // The minimal reproduction from issue #1559: write `7` into a generic
        // static field through the constructed-type receiver, then read it back.
        const source = `package i1559writeread
import System

class Foo[T]() {
    func Set() {
        Foo[T].x = 7
    }
    func Get() int32 -> Foo[T].x
    shared {
        var x int32 = 5
    }
}

func Main() {
    let f = Foo[int32]()
    f.Set()
    System.Console.WriteLine(f.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_CompoundAssign_GenericStaticField_Runs() {
        // `Box[T].x += 10` — compound assignment reaches the assignment-target
        // binder through the event-subscription fallback; it must resolve the
        // constructed-type receiver rather than binding it as element access.
        const source = `package i1559compound
import System

class Box[T]() {
    func Bump() {
        Box[T].x += 10
    }
    func Get() int32 -> Box[T].x
    shared {
        var x int32 = 1
    }
}

func Main() {
    let b = Box[int32]()
    b.Bump()
    b.Bump()
    System.Console.WriteLine(b.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("21${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_IncrementDecrement_GenericStaticField_Runs() {
        // `Cnt[T].n++` / `Cnt[T].n--` desugar to a member-field assignment whose
        // receiver is the constructed-type reference.
        const source = `package i1559incdec
import System

class Cnt[T]() {
    func Up() {
        Cnt[T].n++
    }
    func Down() {
        Cnt[T].n--
    }
    func Get() int32 -> Cnt[T].n
    shared {
        var n int32 = 10
    }
}

func Main() {
    let c = Cnt[int32]()
    c.Up()
    c.Up()
    c.Up()
    c.Down()
    System.Console.WriteLine(c.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_StaticPropertySetter_GenericType_Runs() {
        // Static PROPERTY setter through a constructed-type receiver:
        // `Cell[T].P = 99` must dispatch through the property's setter.
        const source = `package i1559propset
import System

class Cell[T]() {
    func Set() {
        Cell[T].P = 99
    }
    func Get() int32 -> Cell[T].P
    shared {
        var backing int32 = 0
        prop P int32 {
            get -> backing
            set { backing = value }
        }
    }
}

func Main() {
    let c = Cell[int32]()
    c.Set()
    System.Console.WriteLine(c.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_StaticPropertyCompound_GenericType_Runs() {
        // Compound assignment on a static property (`Acc[T].P += 5`) round-trips
        // through getter + setter on the construction.
        const source = `package i1559propcompound
import System

class Acc[T]() {
    func Add() {
        Acc[T].P += 5
    }
    func Get() int32 -> Acc[T].P
    shared {
        var backing int32 = 100
        prop P int32 {
            get -> backing
            set { backing = value }
        }
    }
}

func Main() {
    let a = Acc[int32]()
    a.Add()
    a.Add()
    System.Console.WriteLine(a.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("110${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_MultipleTypeArguments_GenericStaticField_Runs() {
        // Multiple type arguments (`Pair[A, B]`) parse as a generic-name
        // receiver, exercising the GenericNameExpression resolver branch.
        const source = `package i1559multiarg
import System

class Pair[A, B]() {
    func Set() {
        Pair[A, B].total = 42
    }
    func Get() int32 -> Pair[A, B].total
    shared {
        var total int32 = 0
    }
}

func Main() {
    let p = Pair[int32, string]()
    p.Set()
    System.Console.WriteLine(p.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableTypeArgument_GenericStaticField_Runs() {
        // A nullable type argument (`Slot[int32?]`) cannot be shaped as an index
        // expression, so the receiver arrives as a GenericNameExpression.
        const source = `package i1559nullablearg
import System

class Slot[T]() {
    func Set() {
        Slot[int32?].v = 5
    }
    func Get() int32 -> Slot[int32?].v
    shared {
        var v int32 = 0
    }
}

func Main() {
    let s = Slot[bool]()
    s.Set()
    System.Console.WriteLine(s.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NestedGenericTypeArgument_GenericStaticField_Runs() {
        // A nested generic type argument (`Wrap[Inner[int32]]`) is a
        // generic-name receiver whose sole argument is itself a construction.
        const source = `package i1559nestedarg
import System

class Inner[T]() { }

class Wrap[T]() {
    func Set() {
        Wrap[Inner[int32]].w = 33
    }
    func Get() int32 -> Wrap[Inner[int32]].w
    shared {
        var w int32 = 0
    }
}

func Main() {
    let x = Wrap[bool]()
    x.Set()
    System.Console.WriteLine(x.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("33${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_PerConstructionStorage_IndependentAcrossArgs_Runs() {
        // Writes through distinct constructions of the same open generic must
        // target independent per-construction static storage.
        const source = `package i1559perconstruction
import System

class Reg[T]() {
    func Set(v int32) {
        Reg[T].slot = v
    }
    func Get() int32 -> Reg[T].slot
    shared {
        var slot int32 = 0
    }
}

func Main() {
    let a = Reg[int32]()
    let b = Reg[string]()
    a.Set(11)
    b.Set(22)
    System.Console.WriteLine(a.Get())
    System.Console.WriteLine(b.Get())
}`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}22${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1559_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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

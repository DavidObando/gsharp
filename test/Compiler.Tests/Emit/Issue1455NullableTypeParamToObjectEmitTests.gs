// <copyright file="Issue1455NullableTypeParamToObjectEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1455 — a NULLABLE generic type-parameter value (`T?`) converting
/// to `object` (or an interface) crashed emit with GS9998
/// "Conversion from 'TOutput?' to 'object' is not yet supported by the emitter".
/// The bare type-parameter box branch only matched `T`, never the
/// (cref:GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol) wrapper, so
/// a `T?` source fell through to the unsupported-conversion throw — and a
/// closely related argument-position case silently emitted UNVERIFIABLE IL
/// (missing `box`). The fix boxes the underlying type-parameter token for a
/// nullable wrapper in both the box and unbox conversion branches, and adds the
/// matching implicit boxing classification so argument / return / interface
/// positions reach that branch instead of being rejected.
open class Issue1455NullableTypeParamToObjectEmitTests {
    @Fact
    func EndToEnd_NullableTypeParamArgumentToObjectList_BoxesAndRuns() {
        // The #1445-family argument-position case from the issue: a `T?` value
        // flows into a `List[object].Add(object)` slot. Before the fix this
        // compiled but produced unverifiable IL (no `box`); IlVerifier.Verify
        // inside the helper asserts the emitted body is now verifiable.
        let source = `package Probe1455Arg
import System
import System.Collections.Generic

open class Holder[TOutput] {
    private var value TOutput
    init(v TOutput) { this.value = v }
    func GetMaybe() TOutput? { return this.value }
    func Stash() List[object] {
        let lst = List[object]()
        lst.Add(GetMaybe())
        return lst
    }
}

func Main() {
    let h = Holder[int32](7)
    Console.WriteLine(h.Stash()[0]!!.ToString()!!)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableTypeParamReturnedAsObject_BoxesAndRuns() {
        // The actual GS9998 throw path: an implicit `T? -> object` widening
        // reaches MethodBodyEmitter.EmitConversion in a regular method body.
        // Before the fix the box branch only matched a bare `T`, so the
        // nullable wrapper fell through to the NotSupportedException throw.
        let source = `package Probe1455Ret
import System

open class Holder[TOutput] {
    private var value TOutput
    init(v TOutput) { this.value = v }
    func GetMaybe() TOutput? { return this.value }
    func AsObject() object -> GetMaybe()
}

func Main() {
    let h = Holder[int32](42)
    Console.WriteLine(h.AsObject()!!.ToString()!!)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableTypeParamToConstraintInterface_BoxesAndRuns() {
        // The interface-target variant: a `T?` over an `IComparable`-constrained
        // type parameter reference-converts to the interface. Scoped to targets
        // the type parameter actually satisfies (a bare `object` or an interface
        // in its constraint set), so unrelated interface targets stay rejected.
        let source = `package Probe1455Iface
import System

open class Holder[T IComparable] {
    private var value T
    init(v T) { this.value = v }
    func GetMaybe() T? -> this.value
    func AsComparable() IComparable -> GetMaybe()
}

func Main() {
    let h = Holder[int32](9)
    Console.WriteLine(h.AsComparable()!!.CompareTo(9).ToString()!!)
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableValueTypeParamToObject_BoxesNullableAndRuns() {
        // The value-type-constrained case: `T?` over `[T struct]` is stored as
        // `Nullable<T>`, so the emitter boxes the `Nullable<T>` token (which
        // yields a boxed `T` for a present value, a null reference otherwise).
        let source = `package Probe1455Struct
import System

open class Holder[T struct] {
    private var value T
    init(v T) { this.value = v }
    func GetMaybe() T? -> this.value
    func AsObject() object -> GetMaybe()
}

func Main() {
    let h = Holder[int32](5)
    Console.WriteLine(h.AsObject()!!.ToString()!!)
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1455_exe_").FullName
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

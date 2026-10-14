// <copyright file="Issue1445TypeParamToNullableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1445 — converting a <b>local / call-result value of a bare generic
/// type parameter <c>T</c></b> into its nullable form `T?` emitted
/// unverifiable IL when `T` is constrained only to an interface (so it is
/// not statically a reference type).
///
/// Root cause: a LINQ-style call whose open return is a bare method type
/// parameter (`First<TSource>() -> TSource`), closed over an
/// in-scope generic type parameter `T`, encodes a symbolic MethodSpec
/// `First<!!T>` that already leaves a `!!T` value on the stack.
/// The erasure-widening skip guard
/// (`TryGetSymbolicSubstitutedImportedCallReturn`) only fired for
/// same-compilation user-type arguments, never a bare type parameter, so the
/// emitter fed the placeholder-closed (erased `object`) return into the
/// widening and produced a spurious `unbox.any !!T` against a stack slot
/// already holding `!!T` (ilverify `StackObjRef`). The fix broadens
/// the guard to also skip when the symbolic return surfaces an in-scope type
/// parameter, mirroring the instance-method variant — so every value source
/// (call result, local, switch/if arm) leaves a clean `!!T` on the stack.
///
/// Each test below compiles, IL-verifies (inside (cref:CompileAndRun)),
/// and runs.
open class Issue1445TypeParamToNullableEmitTests {
    @Fact
    func EndToEnd_CallResultTypeParamReturnedAsNullable_VerifiesAndRuns() {
        // The headline repro: a `T` call-result returned directly as `T?`.
        let source = `package Probe1445Call
import System
import System.Collections.Generic
import System.Linq

interface IThing1445Call {}
open class Thing1445Call : IThing1445Call {}

func Pick[T IThing1445Call](items IEnumerable[T]) T? {
    return items.First()
}

func Main() {
    let l = List[Thing1445Call]()
    l.Add(Thing1445Call())
    Console.WriteLine(Pick[Thing1445Call](l) != nil)
}`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_LocalTypeParamReturnedAsNullable_VerifiesAndRuns() {
        // The same value flowing through an explicit local of type `T`.
        let source = `package Probe1445Local
import System
import System.Collections.Generic
import System.Linq

interface IThing1445Local {}
open class Thing1445Local : IThing1445Local {}

func Pick[T IThing1445Local](items IEnumerable[T]) T? {
    let v T = items.First()
    return v
}

func Main() {
    let l = List[Thing1445Local]()
    l.Add(Thing1445Local())
    Console.WriteLine(Pick[Thing1445Local](l) != nil)
}`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_SwitchArmTypeParamAsNullable_VerifiesAndRuns() {
        // The same value as a `switch`-expression arm targeting `T?`.
        let source = `package Probe1445Switch
import System
import System.Collections.Generic
import System.Linq

interface IThing1445Switch {}
open class Thing1445Switch : IThing1445Switch {}

func Pick[T IThing1445Switch](items IEnumerable[T]) T? {
    return switch items.Count() {
        case 1: items.First()
        default: nil
    }
}

func Main() {
    let l = List[Thing1445Switch]()
    l.Add(Thing1445Switch())
    Console.WriteLine(Pick[Thing1445Switch](l) != nil)
}`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_GenericClassAccessorReturnsNullable_VerifiesAndRuns() {
        // The Oahu `Box.GetChild<T>()`-style accessor: a generic class method
        // returning `T?` from a collection lookup, via both an inferred local
        // and a direct call result.
        let source = `package Probe1445Box
import System
import System.Collections.Generic
import System.Linq

interface INode1445 {}
open class Node1445 : INode1445 {}

open class Box1445[T INode1445] {
    private var items List[T] = List[T]()
    func Add(x T) { this.items.Add(x) }
    func GetChild() T? {
        let found = this.items.First()
        return found
    }
    func GetChildDirect() T? -> this.items.First()
}

func Main() {
    let b = Box1445[Node1445]()
    b.Add(Node1445())
    Console.WriteLine(b.GetChild() != nil)
    Console.WriteLine(b.GetChildDirect() != nil)
}`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_ValueTypeConstrainedTypeParamLiftsToNullable_VerifiesAndRuns() {
        // Control for the value-type path: a `[T struct]` call-result lifts to
        // a real `Nullable<T>` (`newobj`), unaffected by the box/unbox-skip
        // generalization above.
        let source = `package Probe1445Struct
import System
import System.Collections.Generic
import System.Linq

func PickV[T struct](items IEnumerable[T]) T? {
    return items.First()
}

func Main() {
    let l = List[int32]()
    l.Add(42)
    Console.WriteLine(PickV[int32](l)!!)
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_ParameterTypeParamAsNullable_StaysVerifiable() {
        // The pre-existing control that already verified clean: a `T`
        // parameter widened to `T?` is a representation-preserving no-op
        // (the return signature erases to `!!T`); it must remain clean.
        let source = `package Probe1445Param
import System

interface IThing1445Param {}
open class Thing1445Param : IThing1445Param {}

func Id[T IThing1445Param](x T) T? { return x }

func Main() {
    Console.WriteLine(Id[Thing1445Param](Thing1445Param()) != nil)
}`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1445_exe_").FullName
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

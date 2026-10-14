// <copyright file="Issue2337NestedGenericInheritanceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2337 — a nested class that implicitly inherits the generic arity of
/// its enclosing generic type (e.g. `class Mid : Base { }` nested inside
/// `class Outer[T]`) carries the enclosing generic's reified
/// (cref:GSharp.Core.CodeAnalysis.Symbols.StructSymbol.TypeParameters)
/// while its own (cref:GSharp.Core.CodeAnalysis.Symbols.StructSymbol.TypeArguments)
/// stays empty. (cref:GSharp.Core.CodeAnalysis.Emit.TypeDefEmitter)'s
/// four `extends`/base-constructor token gates previously routed a base
/// through the self-instantiation TypeSpec ONLY when `TypeArguments` was
/// non-empty (issue #1055's explicitly-constructed-base case), so a nested
/// sibling base fell through to the bare open TypeDef/base-ctor MethodDef.
/// ILVerify then rejects the emitted assembly with a
/// `found ref Derived<T0>, expected ref Base<T0>`
/// `StackUnexpected` error wherever the mismatched token surfaces on the
/// stack (e.g. a `callvirt` dispatch through a base-typed reference).
///
/// The fix widens all four gates to
/// `ReflectionMetadataEmitter.IsUserGenericTypeReference(baseClass)` — the
/// existing shared predicate (already used elsewhere in
/// `TypeDefEmitter`/`ReflectionMetadataEmitter` for the identical
/// "does this reference need a TypeSpec instead of a bare TypeDef" question) —
/// which is `true` when EITHER `TypeArguments` is
/// non-empty (a constructed base, #1055) OR the base's own
/// `TypeParameters` is non-empty (an open definition — including a nested
/// sibling reified over its enclosing generic's parameters, #2337). Using one
/// shared predicate at all four sites prevents them drifting out of sync
/// again.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed and not cleared between
/// tests.
open class Issue2337NestedGenericInheritanceEmitTests {
    @Fact
    func EndToEnd_ThreeLevelNestedSiblingInheritance_UnderGenericOuter_VerifiesAndRuns() {
        // The exact issue repro shape (Base / Mid : Base / Leaf : Mid, all
        // nested inside a generic Outer[T]), surfaced through a callvirt
        // dispatch on a Base-typed reference — the precise scenario that
        // reported `found ref Leaf<T0>, expected ref Base<T0>` pre-fix.
        let source = `package Issue2337ThreeLevel
import System

class Outer2337a[T] {
    open class Base2337a {
        open func Speak() string { return "base" }
    }
    open class Mid2337a : Base2337a { }
    open class Leaf2337a : Mid2337a {
        override func Speak() string { return "leaf" }
    }

    func MakeLeaf() Base2337a {
        return Leaf2337a()
    }
}

func Main() {
    var o = Outer2337a[int32]()
    var b = o.MakeLeaf()
    Console.WriteLine(b.Speak())
}`
        let output = CompileAndRun(source)
        Assert.Equal("leaf${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DirectNestedSiblingBaseCall_SkipsMidLevel_VerifiesAndRuns() {
        // Leaf calls `base.Speak()` (its direct base is Mid, which does not
        // declare Speak, so the call resolves up through to Base). The
        // non-virtual `call` instruction's declaring-type token must be the
        // self-instantiation TypeSpec too, not the bare TypeDef.
        let source = `package Issue2337DirectCall
import System

class Outer2337b[T] {
    open class Base2337b {
        open func Speak() string { return "base" }
    }
    open class Mid2337b : Base2337b { }
    class Leaf2337b : Mid2337b {
        override func Speak() string { return "leaf->" + base.Speak() }
    }

    func MakeLeaf() Base2337b {
        return Leaf2337b()
    }
}

func Main() {
    var o = Outer2337b[int32]()
    var b = o.MakeLeaf()
    Console.WriteLine(b.Speak())
}`
        let output = CompileAndRun(source)
        Assert.Equal("leaf->base${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NestedSiblingBaseConstructorChaining_UnderGenericOuter_VerifiesAndRuns() {
        // Explicit `init(...) : base(...)` chaining across all three nested
        // sibling levels (GetBaseInitializerCtorToken, private helper #4)
        // must also route through the self-instantiation TypeSpec.
        let source = `package Issue2337CtorChain
import System

class Outer2337c[T] {
    open class Base2337c {
        var Value int32
        init(v int32) { Value = v }
    }
    open class Mid2337c : Base2337c {
        init(v int32) : base(v) { }
    }
    class Leaf2337c : Mid2337c {
        init(v int32) : base(v) { }
    }

    func MakeLeaf(v int32) Base2337c {
        return Leaf2337c(v)
    }
}

func Main() {
    var o = Outer2337c[int32]()
    var b = o.MakeLeaf(42)
    Console.WriteLine(b.Value)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ExplicitConstructedBase_Issue1055Control_StillVerifiesAndRuns() {
        // Control: issue #1055's ORIGINAL case — a base explicitly constructed
        // with concrete type arguments (TypeArguments non-empty, TypeParameters
        // empty on the reference) — must remain routed through the same
        // self-instantiation/constructed-base TypeSpec helpers after widening
        // the gate to the shared IsUserGenericTypeReference predicate.
        let source = `package Issue2337Ctrl1055
import System

open class Base2337Ctrl1055[TIn, TOut] {
    open func Transform(x TIn) TOut;
}
class Derived2337Ctrl1055 : Base2337Ctrl1055[int32, int32] {
    override func Transform(x int32) int32 { return x + 1 }
}

func Main() {
    let b Base2337Ctrl1055[int32, int32] = Derived2337Ctrl1055()
    Console.WriteLine(b.Transform(41))
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NonGenericNestedSiblingInheritance_ControlStillVerifiesAndRuns() {
        // Control: the SAME three-level nested sibling shape, but the
        // enclosing type is NON-generic — neither TypeArguments nor
        // TypeParameters is ever populated on the base reference, so this path
        // was never affected by the bug and must remain clean after the fix.
        let source = `package Issue2337NonGenericCtrl
import System

class Outer2337Ctrl {
    open class Base2337Ctrl {
        open func Speak() string { return "base" }
    }
    open class Mid2337Ctrl : Base2337Ctrl { }
    class Leaf2337Ctrl : Mid2337Ctrl {
        override func Speak() string { return "leaf" }
    }
}

func Main() {
    let b Outer2337Ctrl.Base2337Ctrl = Outer2337Ctrl.Leaf2337Ctrl()
    Console.WriteLine(b.Speak())
}`
        let output = CompileAndRun(source)
        Assert.Equal("leaf${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_OahuTreeDecompositionShape_BaseCustomToStringCustomFormatString_VerifiesAndRuns() {
        // The real Oahu occurrence that discovered this bug: a
        // TreeDecomposition[T]-shaped generic outer with a nested
        // Base / CustomToString : Base / CustomFormatString : CustomToString
        // sibling family, where the leaf override calls up through
        // `base.Describe()` and is dispatched through a Base-typed reference.
        let source = `package Oahu.Aux.Diagnostics
import System

class TreeDecomposition2337[T] {
    open class Base2337Oahu {
        open func Describe() string { return "base" }
    }
    open class CustomToString2337 : Base2337Oahu {
        open override func Describe() string { return "custom-to-string" }
    }
    class CustomFormatString2337 : CustomToString2337 {
        override func Describe() string { return "custom-format-string:" + base.Describe() }
    }

    func MakeFormatString() Base2337Oahu {
        return CustomFormatString2337()
    }
}

func Main() {
    var td = TreeDecomposition2337[int32]()
    var b = td.MakeFormatString()
    System.Console.WriteLine(b.Describe())
}`
        let output = CompileAndRun(source)
        Assert.Equal("custom-format-string:custom-to-string${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2337_exe_").FullName
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

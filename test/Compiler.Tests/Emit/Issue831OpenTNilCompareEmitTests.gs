// <copyright file="Issue831OpenTNilCompareEmitTests.cs" company="GSharp">
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

/// Issue #831 / ADR-0084 follow-up. End-to-end emit + IL-verify
/// coverage for `T? == nil` / `T? != nil` and the closely-related
/// `self!!` / `self ?? defaultValue` patterns where `T` is an open
/// type parameter constrained with `[T class]` (or left unconstrained).
///
/// Pre-fix the emitter naively produced
///
/// ldarg.0; ldnull; ceq // for `== nil`
/// ldarg.0; dup; brtrue; ... // for `!!`
/// ldarg.0; dup; brtrue; ... // for `??`
///
/// against an opaque `!!T` stack value — the runtime JIT tolerated it
/// for reference-typed T but `ilverify` rejected the IL with
/// `[StackUnexpected]: found Nullobjref ... expected value 'T'` (and
/// related Stack errors for `dup; brtrue` on a type-parameter slot).
/// The fix routes every site through a verifier-clean `box !!T` plus
/// `ldnull; ceq` / `brtrue` sequence. The JIT elides the box when T
/// resolves to a reference type, so the optimized native shape is
/// equivalent.
///
/// Each test compiles the source with gsc, gates the produced PE
/// through (cref:IlVerifier.Verify(string, System.Collections.Generic.IEnumerable{string},
/// System.Collections.Generic.IEnumerable{string})),
/// then runs it under `dotnet exec` and asserts on the captured stdout.
open class Issue831OpenTNilCompareEmitTests {
    @Fact
    func OpenTNilCompare_ClassConstrained_RoundTrip_Verifiable() {
        // Mirrors the Gsharp.Extensions.Optional.Map repro from issue
        // #831 (the body in src/Sdk/Gsharp.Extensions/Optional/Optional.gs):
        // `if self == nil { return nil }; return f(self!!)`. The
        // pre-fix emit shape failed ilverify with
        //   [StackUnexpected]: found Nullobjref 'NullReference'
        //                       expected value 'T'
        // at offset 0x16 (the `ldnull; ceq` over an opaque `!!T`
        // operand). The smart-cast unwrap `self!!` then produced a
        // second `dup; brtrue` failure on the same opaque slot — the
        // fix has to clean BOTH sites for runtime success.
        let source = `package P
import System

func MapOrFallback[T class](self T?, f (T) -> T, fallback T) T {
    if self == nil {
        return fallback
    }

    return f(self!!)
}

var present string? = "hello"
var absent string? = nil
Console.WriteLine(MapOrFallback(present, (s string) -> s + "!", "missing"))
Console.WriteLine(MapOrFallback(absent, (s string) -> s + "!", "missing"))`
        let output = CompileAndRun(source)
        Assert.Equal("hello!${Environment.NewLine}missing${Environment.NewLine}", output)
    }

    @Fact
    func OpenTNilCompare_ClassConstrained_NotEquals_Verifiable() {
        // The `!= nil` lobe goes through the same emit guard with an
        // appended `ldc.i4.0; ceq` for the negation. Exercise it on its
        // own so a regression in the `!=` branch surfaces independently
        // of the `==` lobe.
        let source = `package P
import System

func IsPresent[T class](self T?) bool {
    return self != nil
}

var present string? = "x"
var absent string? = nil
Console.WriteLine(IsPresent(present))
Console.WriteLine(IsPresent(absent))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func OpenTNullCoalesce_ClassConstrained_Verifiable() {
        // Mirrors `OrElse[T class]` from Optional.gs:
        // `func (self T?) OrElse[T class](defaultValue T) T { return self ?? defaultValue }`.
        // Pre-fix the bottom-of-EmitBinary `dup; brtrue` emitted an
        // invalid `dup` over an opaque `!!T` slot. The fix spills the
        // LHS to a `!!T`-typed slot and probes via `box; brfalse`.
        let source = `package P
import System

func OrElse[T class](self T?, defaultValue T) T {
    return self ?? defaultValue
}

var present string? = "value"
var absent string? = nil
Console.WriteLine(OrElse(present, "fallback"))
Console.WriteLine(OrElse(absent, "fallback"))`
        let output = CompileAndRun(source)
        Assert.Equal("value${Environment.NewLine}fallback${Environment.NewLine}", output)
    }

    @Fact
    func OpenTNullAssertion_ClassConstrained_NonNull_Verifiable() {
        // `!!` (NullAssertion) over an open `[T class]` operand — both
        // the un-narrowed `T?` shape and the smart-cast `bare T` shape
        // (when the call sits after an `if self == nil` guard) now use
        // the verifier-clean `box; brtrue; throw NRE; load slot`
        // sequence in place of the old `dup; brtrue; throw NRE`.
        let source = `package P
import System

func UnwrapOrDefault[T class](self T?, fallback T) T {
    if self == nil {
        return fallback
    }

    return self!!
}

var present string? = "present"
var absent string? = nil
Console.WriteLine(UnwrapOrDefault(present, "fallback"))
Console.WriteLine(UnwrapOrDefault(absent, "fallback"))`
        let output = CompileAndRun(source)
        Assert.Equal("present${Environment.NewLine}fallback${Environment.NewLine}", output)
    }

    @Fact
    func OpenTNullAssertion_ClassConstrained_NullThrows_Verifiable() {
        // Belt-and-braces: when the input IS null and the guard is
        // bypassed, the runtime must still throw NullReferenceException
        // (preserving the pre-fix semantics). Confirms the new emit
        // shape didn't accidentally drop the throw branch.
        let source = `package P
import System

func RawUnwrap[T class](self T?) T {
    return self!!
}

var s string? = nil
try {
    Console.WriteLine(RawUnwrap(s))
} catch (e NullReferenceException) {
    Console.WriteLine("caught")
}`
        let output = CompileAndRun(source)
        Assert.Equal("caught${Environment.NewLine}", output)
    }

    @Fact
    func OpenTNilCompare_StructConstrained_PassesIlverify() {
        // Issue #831 originally targeted `[T class]` operands, but the
        // same emit gap existed for `[T struct]`: the existing
        // value-type Nullable<T> lifted-binary collector only catches
        // operands with a static `ClrType`, which open type parameters
        // never have. Without a guard, `Nullable<!!T> == nil` for open
        // struct-T also fell through to the bottom of EmitBinary and
        // produced `<Nullable<!!T>>; ldnull; ceq` — ilverify rejected
        // with `expected value 'Nullable`1<T>'`. The fix uses the same
        // `box; ldnull; ceq` shape for ALL open-T nullables: the CLR
        // box of `Nullable<T>` per ECMA-335 III.4.1 yields a managed-
        // null reference when HasValue is false, so the comparison
        // semantically agrees with the pre-fix runtime behaviour.
        let source = `package P
import System

func StructIsPresent[T struct](self T?) bool {
    if self == nil {
        return false
    }

    return true
}

var present int32? = 42
var absent int32? = nil
Console.WriteLine(StructIsPresent(present))
Console.WriteLine(StructIsPresent(absent))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func OpenTNilCompare_BothOverloads_DispatchedCorrectly() {
        // End-to-end check that two parallel overloads — one
        // `[T class]`, one `[T struct]` — both compile to verifier-clean
        // IL via the same emit path and that argument dispatch picks
        // the right one per call site. Class-T boxes a bare `!!T`
        // reference slot (no-op the JIT elides); struct-T boxes a
        // `Nullable<!!T>` value-typed slot (the CLR yields a null
        // reference when HasValue is false). The `box; ldnull; ceq`
        // shape works uniformly.
        let source = `package P
import System

func ClassifyClass[T class](self T?) int32 {
    if self == nil {
        return 0
    }

    return 1
}

func ClassifyStruct[T struct](self T?) int32 {
    if self == nil {
        return 0
    }

    return 1
}

var refSome string? = "a"
var refNone string? = nil
var valSome int32? = 99
var valNone int32? = nil

Console.WriteLine(ClassifyClass(refSome))
Console.WriteLine(ClassifyClass(refNone))
Console.WriteLine(ClassifyStruct(valSome))
Console.WriteLine(ClassifyStruct(valNone))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "1${Environment.NewLine}0${Environment.NewLine}1${Environment.NewLine}0${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue831_emit_").FullName
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

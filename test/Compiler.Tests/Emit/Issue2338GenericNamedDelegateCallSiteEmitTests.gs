// <copyright file="Issue2338GenericNamedDelegateCallSiteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2338 follow-up (root cause of the "generic named-delegate call-site
/// defect" discovered while testing `EmitFunctionLiteralToNamedDelegate`):
/// calling a generic G# user function/method whose parameter or return type is
/// a NAMED delegate (`delegate Getter[T any]() T`) constructed;
/// over the callee's OWN type parameter produced a <em>caller-side</em> type
/// mismatch, independent of any closure/capture.
///
/// Root cause: `Binder.SubstituteType` — the substitution routine
/// (cref:OverloadResolver) uses to
/// compute a generic call's substituted parameter/return types (for source
/// functions, methods, and extension methods alike, both instance and shared)
/// — had no case for `DelegateTypeSymbol`, unlike its sibling
/// `StructSymbol.SubstituteTypeForConstruction` which already substitutes
/// through a constructed named delegate's type arguments (issue #1503). A
/// call like `func MakeGetter[T](item T) Getter[T]` therefore bound with
/// its ORIGINAL (still-open, `Getter<T>`) return type even when
/// instantiated over a concrete argument, instead of the substituted
/// `Getter<int32>`. The emitter's `MethodSpec` for the call
/// itself was always correct (built directly from the substitution
/// dictionary), so the actual value produced on the stack was the correctly
/// closed `Getter<int32>` — but the caller's declared local
/// variable / subsequent-use type (derived from the wrong, still-open binder
/// type) disagreed, failing ilverify with `StackUnexpected` ("found ref
/// Getter<int32>, expected ref Getter<!!0>") or, in some binding
/// shapes, rejecting the call outright at compile time with a spurious
/// `GS0155` conversion diagnostic.
///
/// The fix adds a `DelegateTypeSymbol` branch to
/// `Binder.SubstituteType` mirroring the existing
/// `StructSymbol.SubstituteTypeForConstruction` branch exactly. Because
/// `Binder.SubstituteType` is the single shared primitive threaded
/// through every generic call-binding path (free functions, instance/shared
/// methods, and extension methods), the fix applies uniformly without
/// special-casing any one call shape.
///
/// - Facet 1 — RETURN position: a generic free function constructs and returns a named delegate closed
/// over its own type parameter, for both a value-type and a reference-type instantiation.
/// - Facet 2 — PARAMETER + ROUND-TRIP: a generic free function takes a named delegate parameter (closed
/// over its own type parameter) and returns it unchanged (identity), exercising both the parameter
/// conversion and the return-type substitution together.
/// - Facet 3 — METHOD-LEVEL generics: a non-generic class's instance method carries its OWN type
/// parameter and returns a named delegate closed over it, called for both a value-type and a
/// reference-type instantiation.
/// - Facet 4 — CONTAINING-TYPE generics: a generic class's instance method (no method-level type
/// parameter of its own) returns a named delegate closed over the class's type parameter, called on
/// both a value-type and a reference-type instantiation of the class.
/// - Facet 5 — SHARED (static) method on a generic class returns a named delegate closed over the
/// class's type parameter.
/// - Facet 6 — CHAINED generic calls: a generic function calls another generic function and forwards
/// its named-delegate return value, for both a value-type and a reference-type instantiation.
/// - Facet 7 — multi-type-parameter named delegate: a two-type-parameter delegate constructed from a
/// lambda argument (parameter-side unification) and returned (return-side substitution) together.
/// - Facet 8 — non-generic control: a plain function returning a non-generic named delegate, confirming
/// no regression in the common case.
/// Every generic facet faulted (ilverify `StackUnexpected` or a spurious
/// `GS0155` compile error) before the fix and passes (clean ilverify +
/// correct runtime output) after it; each was independently confirmed against
/// the reverted fix.
open class Issue2338GenericNamedDelegateCallSiteEmitTests {
    @Fact
    func Facet1_ReturnPosition_GenericFunctionReturnsDelegateOverOwnTypeParam_ValueAndReferenceType_Runs() {
        let source = `package Cap2338CsReturn
import System

delegate Getter2338CsReturn[T any]() T;

func MakeGetter2338CsReturn[T](item T) Getter2338CsReturn[T] {
    return () -> item
}

func Main() {
    var g = MakeGetter2338CsReturn[int32](42)
    Console.WriteLine(g.Invoke())
    var gs = MakeGetter2338CsReturn[string]("hi")
    Console.WriteLine(gs.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func Facet2_ParameterAndReturnRoundTrip_GenericFunctionTakesAndReturnsSameDelegateType_Runs() {
        let source = `package Cap2338CsRoundTrip
import System

delegate Getter2338CsRoundTrip[T any]() T;

func RoundTrip2338Cs[T](g Getter2338CsRoundTrip[T]) Getter2338CsRoundTrip[T] {
    return g
}

func Main() {
    var src Getter2338CsRoundTrip[int32] = func() int32 { return 7 }
    var g = RoundTrip2338Cs[int32](src)
    Console.WriteLine(g.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func Facet3_MethodLevelGenerics_InstanceMethodWithOwnTypeParameter_NonGenericClass_Runs() {
        let source = `package Cap2338CsMethodLevel
import System

delegate Getter2338CsMethodLevel[T any]() T;

class Utils2338CsMethodLevel {
    func Wrap[T](item T) Getter2338CsMethodLevel[T] {
        return () -> item
    }
}

func Main() {
    var u = Utils2338CsMethodLevel()
    var g = u.Wrap[int32](11)
    Console.WriteLine(g.Invoke())
    var gs = u.Wrap[string]("method")
    Console.WriteLine(gs.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}method${Environment.NewLine}", output)
    }

    @Fact
    func Facet4_ContainingTypeGenerics_InstanceMethodReturnsDelegateOverClassTypeParam_ValueAndReferenceType_Runs() {
        let source = `package Cap2338CsContainingType
import System

delegate Getter2338CsContainingType[T any]() T;

open class Holder2338CsContainingType[T] {
    let value T
    init(value T) { this.value = value }
    func MakeGetter() Getter2338CsContainingType[T] {
        return () -> this.value
    }
}

func Main() {
    var hi = Holder2338CsContainingType[int32](42)
    Console.WriteLine(hi.MakeGetter().Invoke())
    var hs = Holder2338CsContainingType[string]("abc")
    Console.WriteLine(hs.MakeGetter().Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}abc${Environment.NewLine}", output)
    }

    @Fact
    func Facet5_SharedStaticMethod_GenericClass_ReturnsDelegateOverClassTypeParam_Runs() {
        let source = `package Cap2338CsShared
import System

delegate Getter2338CsShared[T any]() T;

class Factory2338CsShared[T] {
    shared {
        func Make(value T) Getter2338CsShared[T] {
            return () -> value
        }
    }
}

func Main() {
    var g = Factory2338CsShared[int32].Make(99)
    Console.WriteLine(g.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func Facet6_ChainedGenericCalls_NestedGenericFunctionForwardsDelegateReturn_ValueAndReferenceType_Runs() {
        let source = `package Cap2338CsChain
import System

delegate Getter2338CsChain[T any]() T;

func MakeGetter2338CsChain[T](item T) Getter2338CsChain[T] {
    return () -> item
}

func Relay2338CsChain[U](item U) Getter2338CsChain[U] {
    return MakeGetter2338CsChain[U](item)
}

func Main() {
    var g = Relay2338CsChain[int32](55)
    Console.WriteLine(g.Invoke())
    var gs = Relay2338CsChain[string]("chained")
    Console.WriteLine(gs.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("55${Environment.NewLine}chained${Environment.NewLine}", output)
    }

    @Fact
    func Facet7_MultiTypeParamDelegate_LambdaArgumentUnificationAndReturn_Runs() {
        let source = `package Cap2338CsMulti
import System

delegate Conv2338CsMulti[TIn any, TOut any](x TIn) TOut;

func MakeConv2338CsMulti[TIn, TOut](fn (TIn) -> TOut) Conv2338CsMulti[TIn, TOut] {
    return (x TIn) -> fn(x)
}

func Main() {
    var c = MakeConv2338CsMulti[int32, string]((x int32) -> "n=" + x.ToString())
    Console.WriteLine(c.Invoke(7))
}`
        let output = CompileAndRun(source)
        Assert.Equal("n=7${Environment.NewLine}", output)
    }

    // Non-generic control: confirms the fix does not disturb the
    // already-correct common (non-generic) case.
    @Fact
    func Facet8_NonGenericControl_PlainFunctionReturnsNonGenericDelegate_Runs() {
        let source = `package Cap2338CsControl
import System

delegate Getter2338CsControl() int32;

func MakeGetter2338CsControl(item int32) Getter2338CsControl {
    return () -> item
}

func Main() {
    var g = MakeGetter2338CsControl(13)
    Console.WriteLine(g.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("13${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2338_callsite_exe_").FullName
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

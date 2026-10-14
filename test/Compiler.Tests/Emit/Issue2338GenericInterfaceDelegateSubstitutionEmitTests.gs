// <copyright file="Issue2338GenericInterfaceDelegateSubstitutionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2338 follow-up: the remaining `InterfaceSymbol.SubstituteType`
/// gap for generic interface methods/properties whose return or parameter
/// type is a named delegate (or a plain generic struct/class) constructed
/// over the interface's own type parameter or the method's own generic
/// parameter.
///
/// Note: issue #2230 (fixed by PR #2249) covered the IMPORTED-CLR interface
/// path — a distinct symbol/binding path from the source-interface
/// (`InterfaceSymbol`) gap fixed here; the two are not conflated.
///
/// Root causes (three independent, compounding gaps, all in the
/// source-interface implementation-matching path):
/// 1. `InterfaceSymbol.SubstituteType` (the construction-time member substitution helper used by
/// `TryResolveMembers`/`SubstituteMethod` when building a CONSTRUCTED generic interface's methods, e.g.
/// `IFactory[int32]`) had no case for `DelegateTypeSymbol` nor `StructSymbol`. A constructed
/// interface's method kept exposing the still-open definition type (e.g. `Getter[T]` / `Box[T]`)
/// instead of the closed instantiation (`Getter[int32]` / `Box[int32]`), which made
/// `DeclarationBinder`'s interface-implementation signature matching reject a genuinely correct
/// implementation with a false-negative `GS0187` ("does not implement interface method"). The fix
/// mirrors the existing `DelegateTypeSymbol`/`StructSymbol` branches already present in
/// `Binder.SubstituteType` and `StructSymbol.SubstituteTypeForConstruction`.
/// 2. `InterfaceSymbol.SubstituteMethod` never copied the original interface method's own
/// (method-level) generic type parameters onto the constructed method, so a generic method (e.g.
/// `func Transform[TOut](...)`) declared on a CONSTRUCTED generic interface silently lost its arity
/// (defaulting to none). This made `DeclarationBinder.TryBuildMethodTypeParameterMap` see a bogus
/// interface-vs-implementer arity mismatch and reject the candidate before signature comparison ever
/// ran — reachable only once gap 1 stopped masking it. Fixed by copying `m.TypeParameters` onto the
/// substituted method.
/// 3. `DeclarationBinder.TypeSignaturesEquivalent` had no case for `DelegateTypeSymbol`, so a named
/// delegate constructed over a METHOD-level generic parameter (not fixed by substituting the
/// interface's own type arguments, since it is the method's own type parameter that differs between the
/// interface's declared signature and the implementer's) still failed to compare as structurally
/// equivalent. Fixed by adding a `DelegateTypeSymbol` branch mirroring the existing
/// `StructSymbol`/`InterfaceSymbol` branches (recursing through `TypeArgumentsEquivalent` so the
/// method-type-parameter map applies).
///
/// Negative/control coverage confirms genuine signature mismatches (wrong
/// type argument, a different named delegate entirely, a real generic-arity
/// mismatch) are still correctly rejected with `GS0187` — the fix only
/// stops FALSE-negative rejections, it does not loosen matching.
///
/// See also `Issue2338GenericInterfaceDelegateSubstitutionTests`
/// (Core.Tests) for pure-binder-level coverage of the same fixes.
open class Issue2338GenericInterfaceDelegateSubstitutionEmitTests {
    @Fact
    func Facet1_InterfaceLevelGenericDelegateReturn_ValueAndReferenceType_Runs() {
        let source = `package Cap2338IfaceReturn
import System

delegate Getter2338IfaceReturn[T any]() T;

interface IFactory2338IfaceReturn[T any] {
    func Make() Getter2338IfaceReturn[T];
}

class ConcreteInt2338IfaceReturn : IFactory2338IfaceReturn[int32] {
    func Make() Getter2338IfaceReturn[int32] {
        return () -> 42
    }
}

class ConcreteStr2338IfaceReturn : IFactory2338IfaceReturn[string] {
    func Make() Getter2338IfaceReturn[string] {
        return () -> "hi"
    }
}

func Main() {
    var ci = ConcreteInt2338IfaceReturn()
    Console.WriteLine(ci.Make().Invoke())
    var cs = ConcreteStr2338IfaceReturn()
    Console.WriteLine(cs.Make().Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func Facet2_InterfaceLevelGenericDelegateParameter_Runs() {
        let source = `package Cap2338IfaceParam
import System

delegate Consumer2338IfaceParam[T any](item T) void;

interface ISink2338IfaceParam[T any] {
    func Accept(c Consumer2338IfaceParam[T]) void;
}

class ConcreteSink2338IfaceParam : ISink2338IfaceParam[int32] {
    func Accept(c Consumer2338IfaceParam[int32]) void {
        c.Invoke(99)
    }
}

func Main() {
    var s = ConcreteSink2338IfaceParam()
    s.Accept(func(x int32) void {
        Console.WriteLine(x)
    })
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func Facet3_InterfaceLevelGenericPlainClassReturn_Runs() {
        let source = `package Cap2338IfaceClass
import System

class Box2338IfaceClass[T any](Value T)

interface IFactory2338IfaceClass[T any] {
    func Make() Box2338IfaceClass[T];
}

class Concrete2338IfaceClass : IFactory2338IfaceClass[int32] {
    func Make() Box2338IfaceClass[int32] {
        return Box2338IfaceClass[int32](7)
    }
}

func Main() {
    var c = Concrete2338IfaceClass()
    Console.WriteLine(c.Make().Value)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func Facet4_MethodLevelGenericDelegateOnNonGenericInterface_ValueAndReferenceType_Runs() {
        let source = `package Cap2338MethodLevel
import System

delegate Getter2338MethodLevel[T any]() T;

interface IFactory2338MethodLevel {
    func Make[T](seed T) Getter2338MethodLevel[T];
}

class Concrete2338MethodLevel : IFactory2338MethodLevel {
    func Make[T](seed T) Getter2338MethodLevel[T] {
        return () -> seed
    }
}

func Main() {
    var c = Concrete2338MethodLevel()
    Console.WriteLine(c.Make[int32](55).Invoke())
    Console.WriteLine(c.Make[string]("world").Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("55${Environment.NewLine}world${Environment.NewLine}", output)
    }

    @Fact
    func Facet5_CombinedInterfaceAndMethodLevelGenericsOverMultiParamDelegate_Runs() {
        let source = `package Cap2338Combined
import System

delegate Combiner2338Combined[A any, B any](item A) B;

interface ITransformer2338Combined[TIn any] {
    func Transform[TOut](conv Combiner2338Combined[TIn, TOut]) TOut;
}

class Concrete2338Combined : ITransformer2338Combined[int32] {
    func Transform[TOut](conv Combiner2338Combined[int32, TOut]) TOut {
        return conv.Invoke(10)
    }
}

func Main() {
    var c = Concrete2338Combined()
    var result = c.Transform[string](func(x int32) string {
        return "n=" + x.ToString()
    })
    Console.WriteLine(result)
}`
        let output = CompileAndRun(source)
        Assert.Equal("n=10${Environment.NewLine}", output)
    }

    @Fact
    func Facet6_ContainingTypeGenericClassImplementingGenericInterfaceOverCombinedGenericDelegate_Runs() {
        // Containing-type generics: the implementing class is itself generic
        // (class-level TIn is not yet a concrete type at the class
        // declaration site) combined with a method-level type parameter
        // (TOut) inside the same delegate signature.
        let source = `package Cap2338Containing
import System

delegate Combiner2338Containing[A any, B any](item A) B;

interface ITransformer2338Containing[TIn any] {
    func Transform[TOut](conv Combiner2338Containing[TIn, TOut]) TOut;
}

class GenericConcrete2338Containing[TIn any](Seed TIn) : ITransformer2338Containing[TIn] {
    func Transform[TOut](conv Combiner2338Containing[TIn, TOut]) TOut {
        return conv.Invoke(Seed)
    }
}

func Main() {
    var c = GenericConcrete2338Containing[int32](21)
    var result = c.Transform[string](func(x int32) string {
        return "n=" + x.ToString()
    })
    Console.WriteLine(result)
}`
        let output = CompileAndRun(source)
        Assert.Equal("n=21${Environment.NewLine}", output)
    }

    @Fact
    func Facet7_NestedGenericDelegateSignature_Runs() {
        // The delegate's own type argument is itself a constructed generic
        // class over the interface's type parameter: Getter[Box[T]].
        let source = `package Cap2338Nested
import System

class Box2338Nested[T any](Value T)
delegate Getter2338Nested[T any]() T;

interface IFactory2338Nested[T any] {
    func Make() Getter2338Nested[Box2338Nested[T]];
}

class Concrete2338Nested : IFactory2338Nested[int32] {
    func Make() Getter2338Nested[Box2338Nested[int32]] {
        return () -> Box2338Nested[int32](123)
    }
}

func Main() {
    var c = Concrete2338Nested()
    Console.WriteLine(c.Make().Invoke().Value)
}`
        let output = CompileAndRun(source)
        Assert.Equal("123${Environment.NewLine}", output)
    }

    // Non-generic control: confirms the fix does not disturb the
    // already-correct common (non-generic-interface) case.
    @Fact
    func Facet8_NonGenericInterfaceControl_Runs() {
        let source = `package Cap2338Control
import System

delegate Getter2338Control() int32;

interface IFactory2338Control {
    func Make() Getter2338Control;
}

class Concrete2338Control : IFactory2338Control {
    func Make() Getter2338Control {
        return () -> 13
    }
}

func Main() {
    var c = Concrete2338Control()
    Console.WriteLine(c.Make().Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("13${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2338_iface_delegate_exe_").FullName
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

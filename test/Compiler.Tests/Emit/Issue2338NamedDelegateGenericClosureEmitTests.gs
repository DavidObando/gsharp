// <copyright file="Issue2338NamedDelegateGenericClosureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2338 follow-up: `EmitFunctionLiteralToNamedDelegate` (a lambda
/// literal converted to a user-declared NAMED delegate type, e.g.
/// `delegate Getter[T any]() T`) was missing the same;
/// generic-closure-reification handling that its sibling
/// `EmitFunctionLiteral` already had for issue #1477. When the lambda
/// captured a value whose type referenced an enclosing generic type/method
/// parameter, the synthesized closure became a "reified" (self-instantiated)
/// generic type (per `ClosureInfo.ConstructedClassSym`), but the
/// named-delegate conversion path still emitted the closure's `newobj`
/// ctor, capture-field `stfld`s, and `ldftn Invoke` against bare
/// cached handles instead of resolving self-instantiation-aware tokens via
/// `ResolveUserCtorTokenForDefault` / `ResolveFieldToken` /
/// `ResolveClosureInvokeFtnToken`. This produced an open-generic token
/// (e.g. `Closure<!0>`) used inside the closure's own constructed
/// generic body — rejected by ilverify with `StackUnexpected` (found the
/// open type where the constructed `Closure<T0>` was expected) and
/// `DelegateCtor` (unrecognized arguments for delegate `.ctor`), and
/// a runtime `TypeLoadException` / `BadImageFormatException`.
///
/// The fix mirrors `EmitFunctionLiteral` exactly: check
/// `IsUserGenericTypeReference(closure.ConstructedClassSym)` and route
/// the ctor/field/invoke tokens through the same resolvers used for the
/// already-correct inferred-delegate-type closure path.
///
/// - Facet A — a generic containing class whose instance method captures `this.value` (a `T`-typed
/// field) in a lambda assigned to a named delegate, invoked for both a value-type and a reference-type
/// instantiation.
/// - Facet B — a generic FUNCTION (MVAR) whose lambda captures the function's type-parameter-typed
/// parameter and assigns it to a named delegate, invoked for both a value-type and reference-type
/// instantiation.
/// - Facet C — a NESTED generic context: a generic method with its own additional type parameter
/// declared inside a generic class, where two lambdas separately capture the class-level type parameter
/// value and the method-level type parameter value, each assigned to the (differently instantiated)
/// named delegate.
/// - Facet D — non-generic control: a plain (non-generic) class/function capturing a local in a lambda
/// assigned to a non-generic named delegate — confirms no regression in the common, already-correct
/// case.
/// All facets faulted (ilverify errors / `BadImageFormatException` at
/// runtime) before the fix and pass (clean ilverify + correct runtime output)
/// after it.
open class Issue2338NamedDelegateGenericClosureEmitTests {
    // Facet A: generic containing class, lambda captures `this.value` (a
    // T-typed field), assigned to a named delegate, invoked in the same
    // method — for both a value-type and a reference-type instantiation.
    @Fact
    func EndToEnd_FacetA_GenericClassCapturesThisField_NamedDelegate_ValueAndReferenceType_Runs() {
        let source = `package Cap2338NamedA
import System

delegate Getter2338NamedA[T any]() T;

class HolderNamedA2338[T] {
    let value T
    init(value T) { this.value = value }
    func Show() {
        var g Getter2338NamedA[T] = () -> this.value
        Console.WriteLine(g.Invoke())
    }
}

func Main() {
    var hi = HolderNamedA2338[int32](7)
    hi.Show()
    var hs = HolderNamedA2338[string]("abc")
    hs.Show()
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}abc${Environment.NewLine}", output)
    }

    // Facet B: generic FUNCTION (MVAR) whose lambda captures the
    // type-parameter-typed parameter and assigns it to a named delegate,
    // invoked inside the same function — for both a value-type and a
    // reference-type instantiation.
    @Fact
    func EndToEnd_FacetB_GenericFunctionCapturesTypeParamValue_NamedDelegate_ValueAndReferenceType_Runs() {
        let source = `package Cap2338NamedB
import System

delegate Getter2338NamedB[T any]() T;

func RunGetter2338NamedB[T](item T) {
    var g Getter2338NamedB[T] = () -> item
    Console.WriteLine(g.Invoke())
}

func Main() {
    RunGetter2338NamedB[int32](42)
    RunGetter2338NamedB[string]("hi")
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    // Facet C: nested generic context — a generic method with its own
    // additional type parameter declared inside a generic class. Two
    // lambdas separately capture the class-level type-parameter value and
    // the method-level type-parameter value, each assigned to a
    // differently-instantiated named delegate.
    @Fact
    func EndToEnd_FacetC_NestedGenericMethodInGenericClass_NamedDelegate_Runs() {
        let source = `package Cap2338NamedC
import System

delegate Getter2338NamedC[T any]() T;

class OuterNamedC2338[T] {
    let outerValue T
    init(outerValue T) { this.outerValue = outerValue }

    func Combine[U](innerValue U) {
        var showOuter Getter2338NamedC[T] = () -> this.outerValue
        var showInner Getter2338NamedC[U] = () -> innerValue
        Console.WriteLine(showOuter.Invoke())
        Console.WriteLine(showInner.Invoke())
    }
}

func Main() {
    var o = OuterNamedC2338[int32](10)
    o.Combine[string]("nested")
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}nested${Environment.NewLine}", output)
    }

    // Facet D: non-generic control — a plain (non-generic) lambda capturing
    // a local, assigned to a non-generic named delegate. Confirms the fix
    // does not disturb the already-correct common case.
    @Fact
    func EndToEnd_FacetD_NonGenericControl_NamedDelegate_Runs() {
        let source = `package Cap2338NamedD
import System

delegate Getter2338NamedD[T any]() T;

func Main() {
    var captured = 99
    var g Getter2338NamedD[int32] = () -> captured
    Console.WriteLine(g.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2338_named_exe_").FullName
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

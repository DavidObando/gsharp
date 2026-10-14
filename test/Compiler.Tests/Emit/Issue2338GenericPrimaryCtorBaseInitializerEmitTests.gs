// <copyright file="Issue2338GenericPrimaryCtorBaseInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2338 regression tests: a generic primary-constructor class/data
/// class with an explicit base initializer
/// (`class Derived[T](...) : Base(args) { }`) previously emitted its
/// own primary-constructor field stores through
/// `EmitClassConstructorWithBaseInitializerBodyBytes` using a bare,
/// open `FieldDef` token rather than the self-instantiation-aware
/// `ResolveFieldToken(classSym, field)` its sibling (no-base-initializer)
/// scaffold already used. ilverify reported `StackUnexpected`: "found
/// ref Derived<T0>, expected ref Derived" at the constructor's
/// `stfld` sites — exactly the same generic-self-instantiation drift
/// previously fixed for auto-properties (issue #989) and field-like events
/// (issue #1611), but at this distinct primary-constructor-with-base-
/// initializer call site.
///
/// Reproducing and fixing this exposed a second, independent, non-generic
/// bug in the same code paths: (cref:GSharp.Core.CodeAnalysis.Emit.DataStructSynthesizer)
/// unconditionally marked the synthesized `Equals(object)`/
/// `GetHashCode()`/`ToString()` overrides `virtual final`,
/// so ANY `open data class` derived from another `open data class`
/// (exactly the shape used by the issue's own minimal repro and by Oahu's
/// `InteractionMessage[T]` shape) threw
/// `TypeLoadException: Declaration referenced in a method implementation
/// cannot be a final method` at type-load time — a distinct defect from
/// the ilverify field-token drift, uncovered only because these tests
/// exercise the "run" step the issue asked for, not just compile+ilverify.
/// Both fixes are covered here so the exact repro described in the issue
/// compiles, verifies, AND runs end-to-end.
///
/// All programs compile+ilverify+run via an in-process `gsc` invocation
/// followed by a `dotnet exec` subprocess, mirroring the issue's ask for
/// "compile + ILVerify + run" coverage. Each test uses a unique package/type
/// name because the in-process `FunctionTypeSymbol` cache is name-keyed.
open class Issue2338GenericPrimaryCtorBaseInitializerEmitTests {
    @Fact
    func MinimalRepro_GenericDataClassWithNonGenericBaseInitializer_CompilesVerifiesAndRuns() {
        // The issue's exact minimal repro.
        const source = `package Gh2338Minimal
import System

open data class Base2338Minimal(Name string) { }
open data class Derived2338Minimal[T](Name string, Value T) : Base2338Minimal(Name) { }

func Main() {
    var d = Derived2338Minimal[int32]("hello", 42)
    Console.WriteLine(d.Name)
    Console.WriteLine(d.Value.ToString())
}`
        Assert.Equal("hello${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func MultipleAndGenericFields_ConstructedOverReferenceTypeArgument_CompilesVerifiesAndRuns() {
        // Multiple primary-ctor fields on the derived class, including two
        // distinct type-parameter-typed fields and a field typed over the
        // class's own OTHER field, constructed over a reference type
        // argument (string) rather than a value type.
        const source = `package Gh2338MultiField
import System

open data class Base2338MultiField(Id int32, Label string) { }
open data class Derived2338MultiField[T, U](Id int32, Label string, First T, Second U) : Base2338MultiField(Id, Label) { }

func Main() {
    var d = Derived2338MultiField[string, int32](7, "widget", "alpha", 99)
    Console.WriteLine(d.Id.ToString())
    Console.WriteLine(d.Label)
    Console.WriteLine(d.First)
    Console.WriteLine(d.Second.ToString())
}`
        Assert.Equal(
            "7${Environment.NewLine}widget${Environment.NewLine}alpha${Environment.NewLine}99${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func OahuInteractionMessageShape_GenericOverPayload_CompilesVerifiesAndRuns() {
        // Exact Oahu occurrence shape from the issue:
        // InteractionMessage<T>(...) : InteractionMessage(Type, Message).
        const source = `package Gh2338Interaction
import System

open data class InteractionMessage(Type string, Message string) { }
open data class InteractionMessage[T](Type string, Message string, Data T) : InteractionMessage(Type, Message) { }

func Main() {
    var m = InteractionMessage[int32]("info", "hello", 99)
    Console.WriteLine(m.Type)
    Console.WriteLine(m.Message)
    Console.WriteLine(m.Data.ToString())
    Console.WriteLine(m.ToString())

    var m2 = InteractionMessage[int32]("info", "hello", 99)
    Console.WriteLine((m == m2).ToString())
    Console.WriteLine(m.Equals(m2).ToString())
    Console.WriteLine((m.GetHashCode() == m2.GetHashCode()).ToString())
}`
        // The derived class re-declares `Type`/`Message` (the shape cs2gs emits
        // for the Oahu record, which C# does not duplicate: #4874), so each
        // declaring type prints its own copy.
        Assert.Equal(
            "info${Environment.NewLine}hello${Environment.NewLine}99${Environment.NewLine}" +
                "InteractionMessage { Type = info, Message = hello, Type = info, Message = hello, Data = 99 }${Environment.NewLine}" +
                "True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NonGenericControl_DataClassWithBaseInitializer_CompilesVerifiesAndRuns() {
        // Control: the non-generic sibling of the minimal repro must keep
        // working (it already used the bare FieldDef path correctly, since a
        // non-generic type's bare FieldDef and self-instantiation token
        // coincide).
        const source = `package Gh2338NonGenericControl
import System

open data class Base2338NonGeneric(Name string) { }
open data class Derived2338NonGeneric(Name string, Value int32) : Base2338NonGeneric(Name) { }

func Main() {
    var d = Derived2338NonGeneric("hello", 42)
    Console.WriteLine(d.Name)
    Console.WriteLine(d.Value.ToString())
}`
        Assert.Equal("hello${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NoBaseInitializerControl_GenericDataClass_CompilesVerifiesAndRuns() {
        // Control: a generic data class primary constructor with NO base
        // initializer already routed through the correctly-fixed sibling
        // scaffold (EmitClassConstructorWithBodyBodyBytes) — pin that this
        // fix didn't disturb it.
        const source = `package Gh2338NoBaseInitControl
import System

open data class Standalone2338[T](Name string, Value T) { }

func Main() {
    var d = Standalone2338[int32]("hello", 42)
    Console.WriteLine(d.Name)
    Console.WriteLine(d.Value.ToString())
}`
        Assert.Equal("hello${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NonDataClassControl_GenericClassWithBaseInitializer_CompilesVerifiesAndRuns() {
        // Control: a plain (non-data) generic open class with a base
        // initializer never involved DataStructSynthesizer's Equals/GetHashCode/
        // ToString overrides, isolating that the field-token fix alone (with
        // no DataStructSynthesizer involvement) is sufficient for this shape.
        const source = `package Gh2338NonDataControl
import System

open class Base2338NonData(Name string) { }
open class Derived2338NonData[T](Name string, Value T) : Base2338NonData(Name) { }

func Main() {
    var d = Derived2338NonData[int32]("hello", 42)
    Console.WriteLine(d.Name)
    Console.WriteLine(d.Value.ToString())
}`
        Assert.Equal("hello${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DataClassExtendsDataClassControl_NonGeneric_TypeLoadsAndRunsWithoutFinalMethodError() {
        // Control isolating the second (independent, non-generic) bug this
        // investigation uncovered: an `open data class` derived from another
        // `open data class` previously threw TypeLoadException
        // ("...cannot be a final method") at load time regardless of
        // generics, because DataStructSynthesizer unconditionally marked
        // Equals(object)/GetHashCode()/ToString() `virtual final`.
        const source = `package Gh2338DataExtendsDataControl
import System

open data class Base2338DataExtendsData(Name string) { }
open data class Derived2338DataExtendsData(Name string, Value int32) : Base2338DataExtendsData(Name) { }

func Main() {
    var d = Derived2338DataExtendsData("hello", 42)
    Console.WriteLine(d.Name)
    Console.WriteLine(d.Value.ToString())
    Console.WriteLine(d.ToString())
}`
        // `Derived` re-declares `Name`, so both copies print (see #4874).
        Assert.Equal(
            "hello${Environment.NewLine}42${Environment.NewLine}Derived2338DataExtendsData { Name = hello, Name = hello, Value = 42 }${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2338baseinit_exe_").FullName
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

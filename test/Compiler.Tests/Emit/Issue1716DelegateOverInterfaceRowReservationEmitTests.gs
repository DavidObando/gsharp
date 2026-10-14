// <copyright file="Issue1716DelegateOverInterfaceRowReservationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1716: a compilation declaring a user interface alongside a named
/// `delegate` type failed to emit with `error GS9998:
/// InvalidOperationException: Delegate '…' .ctor MethodDef row N did not
/// match the reserved row M`.
///
/// Root cause: MethodDef rows are RESERVED (during row planning) in the
/// order interface abstract/default methods, then delegate `.ctor`/
/// `Invoke`, then class/struct members. But the rows were actually
/// EMITTED (via `AddMethodDefinition`) in a different order —
/// `EmitDelegateTypeDef` adds its ctor/Invoke MethodDefs eagerly during
/// the TypeDef-emission pass, while interface method bodies were deferred to
/// a later pass shared with classes/structs. So whenever a compilation had at
/// least one interface member, the delegate's eager rows landed first in the
/// metadata even though they were reserved second, producing a mismatched
/// (and invalid) MethodDef row / TypeDef.methodList pointer.
///
/// Fix: emit interface method bodies (`EmitInterfaceMethodBodies`)
/// immediately after interface TypeDefs and BEFORE delegate TypeDefs are
/// emitted, so the actual `AddMethodDefinition` call order matches the
/// reserved row plan for every interface + delegate combination, not just a
/// single hard-coded shape. Each test below uses a UNIQUE package/type name
/// because the in-process `FunctionTypeSymbol` cache is name-keyed.
open class Issue1716DelegateOverInterfaceRowReservationEmitTests {
    @Fact
    func EndToEnd_InterfaceAndNamedDelegate_Coexist_Runs() {
        const source = `package i1716basic
import System

interface IGreeter1716 {
    func Greet() string;
}

class Greeter1716 : IGreeter1716 {
    func Greet() string { return "hi-1716" }
}

delegate StringFn1716() string;

func Main() {
    var g IGreeter1716 = Greeter1716()
    var d StringFn1716 = g.Greet
    System.Console.WriteLine(d.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("hi-1716${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_MultipleInterfacesAndDelegates_Interleaved_Runs() {
        // Generalization check: several interfaces (with default-body AND
        // abstract methods, properties, events) and several named delegates
        // in one compilation. This exercises the full MethodDef row plan
        // (interfaces first, then all delegate ctor/Invoke pairs, then
        // classes) so the fix isn't specific to "one interface, one delegate".
        const source = `package i1716multi
import System

interface IFirst1716 {
    func FirstOp() int32;
    func FirstDefault() int32 { return 100 }
}

interface ISecond1716 {
    func SecondOp() int32;
}

class Impl1716 : IFirst1716, ISecond1716 {
    func FirstOp() int32 { return 1 }
    func SecondOp() int32 { return 2 }
}

delegate IntFn1716() int32;
delegate IntFn1716B() int32;

func Main() {
    var f IFirst1716 = Impl1716()
    var s ISecond1716 = Impl1716()
    var d1 IntFn1716 = f.FirstOp
    var d2 IntFn1716B = s.SecondOp
    var d3 IntFn1716 = f.FirstDefault
    System.Console.WriteLine(d1.Invoke() + d2.Invoke() + d3.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("103${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_InterfaceBodyConstructsPrimaryCtorStruct_Runs() {
        // Latent hazard #1 flagged in PR #1796 review: same root cause as the
        // class ctor regression (ClassCtorHandles / ClassPrimaryCtorHandles
        // populated too late for interface bodies to see), but for a VALUE
        // TYPE. A data struct's primary-ctor handle is registered inside
        // EmitDataStructSynthesizedMembers, called from EmitStructMethodBodies
        // — which still runs AFTER EmitInterfaceMethodBodies. An interface
        // `shared func` that `newobj`s a primary-ctor struct should still
        // resolve the ctor handle.
        const source = `package i1716struct
import System

inline struct Box1716(N int32) { }

interface IBoxFactory1716 {
    shared {
        func Make(n int32) Box1716 {
            return Box1716(n)
        }
    }
}

func Main() {
    let b = IBoxFactory1716.Make(42)
    System.Console.WriteLine(b.N)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_InterfaceBodyConstructsNamedDelegate_Runs() {
        // Latent hazard #2 flagged in PR #1796 review: DelegateCtorHandles is
        // populated inside EmitDelegateTypeDef, which still runs AFTER
        // EmitInterfaceMethodBodies. An interface body performing a
        // method-group -> named-delegate conversion should still resolve the
        // delegate's .ctor MethodDef.
        // The method-group source is another `shared` method on the SAME
        // interface, emitted earlier in interface-body emission order — a
        // top-level `func` source would additionally hit the (out-of-scope,
        // unrelated) fact that top-level function MethodDef handles aren't
        // registered until phase B4, later still than interface bodies.
        const source = `package i1716del
import System

delegate IntFn1716D(n int32) int32;

interface IConverter1716 {
    shared {
        func Double1716D(n int32) int32 { return n * 2 }
        func GetDoubler() IntFn1716D {
            var d IntFn1716D = IConverter1716.Double1716D
            return d
        }
    }
}

func Main() {
    let fn = IConverter1716.GetDoubler()
    System.Console.WriteLine(fn.Invoke(21))
}`
        // Issue #755's static-virtual interface members are always emitted
        // Virtual|NewSlot (even the sole implementation), so ldftn on one for
        // delegate creation trips ilverify's non-final-virtual check — a
        // known, already-tracked ilverify gap for this feature (see
        // IlVerifier.KnownIssues.StaticVirtualInterface for the sibling
        // CallAbstract/Constrained codes); the CLR JIT accepts and dispatches
        // the IL correctly, confirmed by the successful run below.
        let output = CompileAndRun(
            source,
            ignoredIlVerifyErrorCodes: []string{"LdftnNonFinalVirtual"},
            ignoredErrorScope: "IConverter1716\\.GetDoubler$$"
        )
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(
            source string,
            ignoredIlVerifyErrorCodes IEnumerable[string]? = nil,
            ignoredErrorScope string? = nil
        ) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1716mg_exe_").FullName
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
                IlVerifier.Verify(
                    dllPath,
                    ignoredErrorCodes: ignoredIlVerifyErrorCodes,
                    ignoredErrorScope: ignoredErrorScope
                )
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

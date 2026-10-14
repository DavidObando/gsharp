// <copyright file="Issue1525StaticReadonlyFieldReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1525 — calling an instance method (or property getter) on a
/// <b>static readonly</b> value-type field emitted `ldsflda` of the
/// `initonly` field to obtain the `this` pointer. Taking the address
/// of an `initonly` field outside its declaring type-initializer is
/// unverifiable (ilverify `InitOnly` "Cannot change initonly field outside
/// its .ctor"). The runtime JIT accepts it but the IL is invalid.
///
/// The fix teaches BOTH mirrored receiver-addressability predicates
/// (`MethodBodyEmitter.IsAddressableFieldAccess` and
/// `ReflectionMetadataEmitter.IsAddressableFieldAccessForReceiverSpill`) to
/// treat a static readonly value-type field as NOT addressable outside its
/// declaring type's `.cctor`, so the existing rvalue-receiver-spill
/// machinery performs a defensive copy (`ldsfld; stloc; ldloca; call`) —
/// exactly as C# does.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue1525StaticReadonlyFieldReceiverEmitTests {
    @Fact
    func EndToEnd_UserStruct_StaticReadonly_InstanceMethod_VerifiesAndRuns() {
        const source = `package i1525userstruct
import System

struct Pt1525 { prop X int32   func Plus(d int32) int32 -> X + d }

class Holder1525 {
    func Compute() int32 -> Holder1525.Origin.Plus(5)
    shared { private let Origin Pt1525 = Pt1525{X: 10} }
}

func Main() { System.Console.WriteLine(Holder1525().Compute()) }`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserStruct_StaticReadonly_PropertyGetter_VerifiesAndRuns() {
        const source = `package i1525userprop
import System

struct Pt1525p { prop X int32 }

class Holder1525p {
    func Compute() int32 -> Holder1525p.Origin.X
    shared { private let Origin Pt1525p = Pt1525p{X: 42} }
}

func Main() { System.Console.WriteLine(Holder1525p().Compute()) }`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FrameworkStruct_DateTimeOffset_StaticReadonly_VerifiesAndRuns() {
        // Mirrors the real Oahu HeaderBox.Datum case: a framework value-type
        // (DateTimeOffset) static readonly field used as an instance-method
        // receiver. Today this emits ldsflda of the initonly field (InitOnly).
        const source = `package i1525dto
import System

class Holder1525d {
    func Compute() int32 -> Holder1525d.D.AddSeconds(1.0).Second
    shared { private let D DateTimeOffset = DateTimeOffset(2000, 1, 1, 0, 0, 0, System.TimeSpan.Zero) }
}

func Main() { System.Console.WriteLine(Holder1525d().Compute()) }`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FrameworkStruct_TimeSpan_StaticReadonly_VerifiesAndRuns() {
        const source = `package i1525timespan
import System

class Holder1525t {
    func Compute() int32 -> Holder1525t.Span.Add(System.TimeSpan(0, 0, 5)).Seconds
    shared { private let Span TimeSpan = System.TimeSpan(0, 0, 10) }
}

func Main() { System.Console.WriteLine(Holder1525t().Compute()) }`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ClrOperator_AppliesImplicitOperandConversion() {
        const source = `package i1525clroperatorconversion
import System

func Main() {
    let cutoff = DateTimeOffset.UtcNow
    let older = DateTime.UtcNow.AddDays(-1.0)
    Console.WriteLine(older < cutoff)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Enum_StaticReadonly_InstanceMethod_VerifiesAndRuns() {
        const source = `package i1525enum
import System

enum Color1525 { Red, Green, Blue }

class HolderEnum1525 {
    func Name() string -> HolderEnum1525.Fav.ToString()
    shared { private let Fav Color1525 = Color1525.Green }
}

func Main() { System.Console.WriteLine(HolderEnum1525().Name()) }`
        let output = CompileAndRun(source)
        Assert.Equal("Green${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Control_MutableStaticValueField_KeepsLdsflda_MutationPersists() {
        // A MUTABLE static value-type field must NOT be defensively copied:
        // address-of (ldsflda) is legal and required so a mutating instance
        // method updates the field in place. If the fix wrongly spilled here,
        // the mutations would be discarded and this would print 0.
        const source = `package i1525mutctrl
import System

struct Counter1525 { var N int32   func Inc() { N = N + 1 } }

class HolderMut1525 {
    func Bump() {
        HolderMut1525.C.Inc()
        HolderMut1525.C.Inc()
    }
    func Value() int32 -> HolderMut1525.C.N
    shared { var C Counter1525 = Counter1525{N: 0} }
}

func Main() {
    let h = HolderMut1525()
    h.Bump()
    System.Console.WriteLine(h.Value())
}`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Cctor_SiblingStaticReadonly_AddressLegal_VerifiesAndRuns() {
        // Inside the declaring type's synthesized .cctor, taking the address of
        // a sibling static readonly value-type field is legal (ECMA-335), so
        // the exemption keeps ldsflda there and must still verify clean.
        const source = `package i1525cctor
import System

struct Pt1525c { prop X int32   func Plus(d int32) int32 -> X + d }

class HolderC1525 {
    func Get() int32 -> HolderC1525.B
    shared {
        private let A Pt1525c = Pt1525c{X: 10}
        private let B int32 = HolderC1525.A.Plus(5)
    }
}

func Main() { System.Console.WriteLine(HolderC1525().Get()) }`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1525_exe_").FullName
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

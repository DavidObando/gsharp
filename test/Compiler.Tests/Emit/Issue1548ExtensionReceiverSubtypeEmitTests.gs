// <copyright file="Issue1548ExtensionReceiverSubtypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1548 — a receiver-clause (extension) function `func (r R) Name(…)`
/// only bound when the call-site receiver type was EXACTLY `R` (identity /
/// same-CLR-type). It must also bind when the call-site receiver type `S`
/// is implicitly convertible to `R` (identity, implicit reference, or
/// boxing conversion), matching C#/Kotlin extension-method receiver semantics.
/// cs2gs translates C# extension methods into receiver-clause funcs, so the
/// exact-only rule blocked most real Oahu translations (the minimal repro
/// `func (o object?) IsNull() bool` called on a `string` emitted
/// `GS0159: Cannot find function IsNull.`).
///
/// The fix broadens `BoundScope.ReceiverConvertible` gating on the extension
/// lookup paths: a CONCRETE declared receiver is applicable whenever
/// `Conversion.Classify(S, R)` is `Exists && IsImplicit`. The
/// exact / same-CLR fast path is still tried first, and the open-receiver
/// generic-unification fallback (#773 / #775) is preserved. Specificity is kept:
/// the plural path collects every applicable candidate and lets overload
/// resolution (which scores the receiver as parameter 0) select the most
/// specific one; the singular path ranks convertible candidates so the
/// most-derived receiver wins deterministically.
///
/// VALUE-TYPE BOXING IS IN SCOPE: an `(o object)` extension binds on an
/// `int32` receiver via a boxing conversion, matching C# (which permits an
/// extension on `object` to be invoked on a value type).
///
/// Interface and base-class generalization are demonstrated with BCL types
/// (`System.IDisposable`, `System.IO.Stream`): a same-package USER
/// interface/aggregate receiver-clause is intentionally rejected by G# (GS0103 /
/// GS0314, ADR-0079/0085 — those belong in the type as a DIM / member), so only
/// non-owned (imported/BCL) receiver types exercise the extension-lookup path
/// that this fix changes. Each test uses a UNIQUE package name and unique user
/// type names because the in-process `FunctionTypeSymbol` cache is
/// name-keyed for user types.
open class Issue1548ExtensionReceiverSubtypeEmitTests {
    /// The minimal repro: an `object?` extension bound on a `string`
    /// receiver via an implicit reference conversion.
    @Fact
    func ExtensionOnObject_CalledOnString_Runs() {
        const source = `package i1548objstr
import System

func (o object?) IsNull1548() bool -> o == nil

func Use(p string) bool -> p.IsNull1548()

func Main() { Console.WriteLine(Use("hi")) }`
        Assert.Equal("False${Environment.NewLine}", CompileAndRun(source))
    }

    /// An `object?` extension bound on a BCL reference receiver
    /// (`System.Text.StringBuilder`) via an implicit reference conversion.
    @Fact
    func ExtensionOnObject_CalledOnBclReference_Runs() {
        const source = `package i1548objbcl
import System
import System.Text

func (o object?) IsNull1548() bool -> o == nil

func Main() {
    let b StringBuilder = StringBuilder()
    Console.WriteLine(b.IsNull1548())
}`
        Assert.Equal("False${Environment.NewLine}", CompileAndRun(source))
    }

    /// GENERALIZATION — an extension whose declared receiver is an INTERFACE
    /// (`System.IDisposable`) binds on a user class that implements it,
    /// through an implicit class-to-implemented-interface reference conversion.
    @Fact
    func ExtensionOnInterface_CalledOnImplementingClass_Runs() {
        const source = `package i1548iface
import System

class Res1548 : IDisposable { func Dispose() { } }

func (d IDisposable) Tag1548() int32 -> 42

func Use() int32 {
    let r Res1548 = Res1548()
    return r.Tag1548()
}

func Main() { Console.WriteLine(Use()) }`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    /// GENERALIZATION — an extension whose declared receiver is a base class
    /// (`System.IO.Stream`) binds on a derived class
    /// (`System.IO.MemoryStream`) through an implicit derived-to-base
    /// reference conversion.
    @Fact
    func ExtensionOnBaseClass_CalledOnDerivedClass_Runs() {
        const source = `package i1548base
import System
import System.IO

func (s Stream) Tag1548() int32 -> 11

func Use() int32 {
    let m MemoryStream = MemoryStream()
    return m.Tag1548()
}

func Main() { Console.WriteLine(Use()) }`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    /// VALUE-TYPE BOXING — an `object` extension binds on an `int32`
    /// receiver via a boxing conversion (in scope, as in C#).
    @Fact
    func ExtensionOnObject_CalledOnValueType_BoxesAndRuns() {
        const source = `package i1548box
import System

func (o object) Boxed1548() int32 -> 7

func Use(n int32) int32 -> n.Boxed1548()

func Main() { Console.WriteLine(Use(3)) }`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    /// SPECIFICITY — with both a `(s string)` and an `(o object)`
    /// overload visible, a call on a `string` receiver must select the more
    /// specific `string` receiver (result `1`), NOT report a spurious
    /// GS0160 ambiguity.
    @Fact
    func Specificity_StringBeatsObject_OnStringReceiver() {
        const source = `package i1548specstr
import System

func (s string) F1548() int32 -> 1
func (o object) F1548() int32 -> 2

func Use(s string) int32 -> s.F1548()

func Main() { Console.WriteLine(Use("x")) }`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    /// SPECIFICITY — with both a `(s string)` and an `(o object)`
    /// overload visible, a call on a NON-string reference receiver
    /// (`System.Text.StringBuilder`) must select the `object` receiver
    /// (result `2`), the only applicable candidate.
    @Fact
    func Specificity_ObjectSelected_OnNonStringReference() {
        const source = `package i1548specobj
import System
import System.Text

func (s string) F1548() int32 -> 1
func (o object) F1548() int32 -> 2

func Use() int32 {
    let b StringBuilder = StringBuilder()
    return b.F1548()
}

func Main() { Console.WriteLine(Use()) }`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(source))
    }

    /// NEGATIVE — a genuinely non-convertible receiver (`int32` for a
    /// `string`-only extension) still reports GS0159; broadening to implicit
    /// conversions must not make unrelated receivers bind.
    @Fact
    func NonConvertibleReceiver_StillReportsGs0159() {
        const source = `package i1548neg
import System

func (s string) OnlyString1548() int32 -> 1

func Use(x int32) int32 -> x.OnlyString1548()

func Main() { Console.WriteLine("x") }`
        let (exit, output) = CompileOnly(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0159", output)
    }

    /// REGRESSION — the generic-receiver unification fallback (#773 / #775) for
    /// an OPEN declared receiver carrying the function's own type parameters
    /// still binds after the subtype broadening.
    @Fact
    func GenericReceiverFallback_StillBinds() {
        const source = `package i1548generic
import System

func (self sequence[T]) HeadOr1548[T](fb T) T {
    return fb
}

var arr = []int32{1, 2, 3}
Console.WriteLine(arr.HeadOr1548(7))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1548_exe_").FullName
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

        private func CompileOnly(source string)(Exit int32, Output string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1548_neg_").FullName
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
                return (compileExit, stdoutWriter.ToString() + stderrWriter.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}

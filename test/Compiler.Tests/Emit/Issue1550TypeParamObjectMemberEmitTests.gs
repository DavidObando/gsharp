// <copyright file="Issue1550TypeParamObjectMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1550 — a member call on a value of an OPEN generic type parameter
/// failed with GS0159 when the member was a universal `System.Object`
/// member (`ToString`, `GetHashCode`, `Equals(object)`,
/// `GetType`), even though those are inherited by every type parameter.
/// The constraint-supplied member paths (#1052 / #1056 / #943) did not cover
/// them, so `t.ToString()` on a type parameter with no matching constraint
/// dead-ended, and the error-typed result cascaded into downstream String
/// calls.
///
/// The fix adds a type-parameter dispatch path (AFTER the constraint paths, so a
/// redeclaring constraint still wins) that resolves the public instance members
/// of `System.Object` on ANY `TypeParameterSymbol` receiver and emits
/// a verifiable `constrained. !!T callvirt System.Object::Method(...)`
/// sequence. The `constrained.` prefix dispatches to any override for
/// value, struct/enum-constrained and reference type parameters alike.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed for user types.
open class Issue1550TypeParamObjectMemberEmitTests {
    @Fact
    func ToString_OnStructConstrainedReceiver_Runs() {
        // The canonical issue repro: `default(T).ToString()` on a `T struct`
        // receiver returns the value's string form. Emitted as
        // `constrained. !!T  callvirt System.Object::ToString()`.
        const source = `package i1550_struct_tostring
import System

func Show[T struct](v T) string -> v.ToString()

func Main() {
    Console.WriteLine(Show[int32](42))
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GetHashCode_OnAnyConstrainedReceiver_Runs() {
        // The second issue repro: `t.GetHashCode()` on an unconstrained (`any`)
        // receiver. Two equal int values hash identically, proving the object
        // member dispatches correctly through the type parameter.
        const source = `package i1550_any_hash
import System

func HashEq[T any](a T, b T) bool -> a.GetHashCode() == b.GetHashCode()

func Main() {
    Console.WriteLine(HashEq[int32](7, 7))
}`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Equals_WithArgument_OnAnyConstrainedReceiver_Runs() {
        // `Equals(object)` binds with an argument: the `T`-typed argument is
        // boxed to System.Object at the call site (the object member's real
        // parameter is System.Object, unlike a CLR-interface type variable).
        const source = `package i1550_any_equals
import System

func Same[T any](a T, b T) bool -> a.Equals(b)

func Main() {
    Console.WriteLine(Same[int32](3, 3))
    Console.WriteLine(Same[int32](3, 4))
}`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GetType_OnAnyConstrainedReceiver_Runs() {
        // `t.GetType().Name` on an unconstrained receiver — the object member
        // returns a non-null System.Type whose Name is the runtime type.
        const source = `package i1550_any_gettype
import System

func TypeName[T any](t T) string -> t.GetType().Name

func Main() {
    Console.WriteLine(TypeName[int32](0))
}`
        Assert.Equal("Int32${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ToString_OnClassConstrainedReceiver_Runs() {
        // A reference (`class`) type parameter: the `constrained.` prefix is
        // still required (a bare callvirt on the unboxed `!!T` is unverifiable).
        // With no user override visible through the opaque `T`, dispatch lands
        // on the default System.Object.ToString (the type's full name).
        const source = `package i1550_class_tostring
import System

class Widget1550 { var N int32 }

func Describe[T class](t T) string -> t.ToString()

func Main() {
    Console.WriteLine(Describe[Widget1550](Widget1550{ N: 1 }))
}`
        Assert.Equal("i1550_class_tostring.Widget1550${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ToString_OnEnumStructConstrainedReceiver_DispatchesOverride() {
        // An `Enum struct`-constrained receiver: the `constrained.` prefix
        // dispatches to the enum's own ToString override (System.Enum overrides
        // System.Object.ToString), printing the member NAME rather than the
        // underlying integer — proof the constrained call reaches the override.
        const source = `package i1550_enum_tostring
import System

func Name[T Enum struct](e T) string -> e.ToString()

func Main() {
    Console.WriteLine(Name[DayOfWeek](DayOfWeek.Monday))
}`
        Assert.Equal("Monday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Cascade_ToStringResultFeedsStringCall_NoLongerCascades() {
        // Regression for the cascade described in the issue: the (previously
        // error-typed) result of `v.ToString()` now has a concrete `string`
        // type, so a downstream String call (`StartsWith`) binds and runs
        // instead of losing further diagnostics.
        const source = `package i1550_cascade
import System

func Starts[T any](v T) bool {
    let s = v.ToString()
    return s.StartsWith("4")
}

func Main() {
    Console.WriteLine(Starts[int32](42))
    Console.WriteLine(Starts[int32](13))
}`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Control_UserInterfaceConstraintMember_StillBinds() {
        // The pre-existing #1052 constraint-dispatch path must be unaffected:
        // `t.Area()` on an interface-constrained receiver still resolves to the
        // constraint interface member (it runs BEFORE the new object path).
        const source = `package i1550_control_iface
import System

interface IShape1550 { func Area() float64; }

struct Sq1550 : IShape1550 {
    var Side float64
    func Area() float64 { return Side * Side }
}

func Describe[T IShape1550](t T) float64 -> t.Area()

func Main() {
    Console.WriteLine(Describe[Sq1550](Sq1550{ Side: 3.0 }))
}`
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Negative_NonexistentMethodOnTypeParam_StillReportsGs0159() {
        // A genuinely nonexistent member on a type parameter must still report
        // GS0159 — the object-member path returns false for any name Object
        // does not define, so it does not mask real errors.
        const source = `package i1550_neg159
import System

func Bad[T any](t T) int32 -> t.NoSuchMethod()`
        let (exit, output) = CompileOnly(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0159", output)
    }

    shared {
        private func CompileOnly(source string)(Exit int32, Output string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1550_neg_").FullName
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

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1550_exe_").FullName
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

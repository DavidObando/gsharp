// <copyright file="Issue2335StructConstrainedGenericPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #2335: a switch/`is` type pattern targeting a bare
/// value-type-constrained generic parameter (`where T : struct`,
/// optionally combined with `Enum`) emitted the reference-type
/// `castclass` path instead of `unbox.any`, producing IL that
/// ILVerify rejects (`StackUnexpected: found ref T, expected value T`)
/// and that stores a boxed reference into a value-typed pattern-variable
/// slot.
///
/// <b>Root cause:</b> `ReflectionMetadataEmitter.IsValueTypeSymbol` — the
/// single shared predicate every box/unbox emit decision in the compiler
/// consults (type patterns, conversions, member-access receiver dispatch,
/// closures, struct/tuple field defaulting, slot planning) — recognized
/// nullable wrappers over a value-type-constrained type parameter
/// (`T?`, issue #806) and several other symbolic value-type shapes, but
/// not a BARE (non-nullable) (cref:Symbols.TypeParameterSymbol) whose
/// (cref:Symbols.TypeParameterSymbol.HasValueTypeConstraint) is
/// `true`. `MethodBodyEmitter.EmitTypePattern` asks this
/// predicate to choose between `unbox.any` (value target) and
/// `castclass` (reference target); for a bare struct-constrained target
/// it wrongly took the reference branch.
///
/// <b>Fix:</b> `IsValueTypeSymbol` now recognizes a bare
/// (cref:Symbols.TypeParameterSymbol) with
/// `HasValueTypeConstraint == true` directly (mirroring the existing
/// `Nullable<T>`-over-struct-constrained-T arm one level up).
/// Because every one of the ~40 `IsValueTypeSymbol` call sites in the
/// emitter shares this one predicate, the fix applies uniformly across type
/// patterns, `is`/narrowing casts, conversions (`box`/`unbox.any`
/// selection), instance-receiver addressing (`call` vs `callvirt`),
/// and struct/tuple default-value field patching — not just
/// `EmitTypePattern`.
///
/// <b>Audit follow-up (adjacent, tightly-coupled gap closed alongside):</b>
/// `EmitTypePattern`'s target-side opcode choice previously fell back to
/// `castclass` for ANY bare type parameter that `IsValueTypeSymbol`
/// did not recognize — including a genuinely UNCONSTRAINED (or class/
/// interface-constrained) `T`. Such a `T` can still close over a
/// value type at a given instantiation (e.g. `case v is T` inside
/// `func F[T](value object, fallback T) T`, called as `F[int32]`),
/// and `castclass !!T` is invalid IL for that closure — verified here to
/// have silently produced a WRONG runtime value pre-fix (reading raw stack
/// bytes as a boxed-reference target instead of unboxing), not merely an
/// ilverify failure. Per ECMA-335 III.4.32, `unbox.any` degrades to the
/// exact `castclass` behavior when the closed type turns out to be a
/// reference type, so it is the single opcode that is correct for every
/// constraint/closure combination; `EmitTypePattern` now routes every
/// bare type-parameter pattern target through it.
///
/// Every test compiles with `gsc`, IL-verifies the produced PE with
/// `ilverify`, then executes it and asserts on captured stdout. Tests
/// that closed over a value type via an unconstrained/class-constrained
/// type parameter also assert on the exact numeric/string value (not merely
/// "it didn't crash"), since the pre-fix bug for that shape was silent value
/// corruption rather than an IL-verifier rejection.
open class Issue2335StructConstrainedGenericPatternEmitTests {
    @Fact
    func SwitchCasePattern_StructConstrainedTypeParameter_Int32_MatchesAndUnwraps() {
        // Test #1 from the issue: `case v is T` with `T : struct`.
        let source = `package i2335struct
import System

func F[T struct](value object, fallback T) T {
    switch value {
        default { return fallback }
        case v is T { return v }
    }
}

var a object = 42
var b object = "nope"
Console.WriteLine(F[int32](a, -1))
Console.WriteLine(F[int32](b, -1))`
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func SwitchCasePattern_StructAndEnumConstrainedTypeParameter_MatchesAndUnwraps() {
        // Test #2 from the issue: `T : struct, Enum` — the exact minimal
        // repro shape from the issue body (`class C[TEnum Enum struct]`).
        let source = `package i2335enum
import System

class C[TEnum Enum struct]() {
    func F(value object) string {
        switch value {
            default { return "other" }
            case enm is TEnum { return enm.ToString() }
        }
    }
}

let c = C[DayOfWeek]()
Console.WriteLine(c.F(DayOfWeek.Friday))
Console.WriteLine(c.F("nope"))`
        Assert.Equal("Friday${Environment.NewLine}other${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func SwitchCasePattern_MultiArm_StringInt32EnumDefault_MatchesEachArm() {
        // Test #3 from the issue: a multi-arm switch mixing a reference-type
        // arm (string), a primitive value-type arm (int32), a struct+Enum
        // constrained generic arm (T), and a default arm.
        let source = `package i2335multiarm
import System

func Describe[T Enum struct](value object) string {
    switch value {
        case s is string { return "string:" + s }
        case n is int32 { return "int32:" + n.ToString() }
        case enm is T { return "enum:" + enm.ToString() }
        default { return "other" }
    }
}

var a object = "hi"
var b object = 7
var c object = DayOfWeek.Tuesday
var d object = 3.5
Console.WriteLine(Describe[DayOfWeek](a))
Console.WriteLine(Describe[DayOfWeek](b))
Console.WriteLine(Describe[DayOfWeek](c))
Console.WriteLine(Describe[DayOfWeek](d))`
        Assert.Equal(
            "string:hi${Environment.NewLine}int32:7${Environment.NewLine}enum:Tuesday${Environment.NewLine}other${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func IfIsNarrowing_StructAndEnumConstrainedTypeParameter_ReturnsNarrowedValue() {
        // Test #4 from the issue: `if x is T` narrowing (as opposed to the
        // switch-statement `case v is T` capture pattern). The narrowed read
        // of `x` (declared `object`, narrowed to the struct-constrained `T`)
        // exercises `MethodBodyEmitter.EmitNarrowingCastIfNeeded`, the
        // sibling consumer of `IsValueTypeSymbol` for `is`-narrowed reads.
        let source = `package i2335ifis
import System

func Probe[T Enum struct](x object, fallback T) T {
    if x is T {
        return x
    }
    return fallback
}

var a object = DayOfWeek.Wednesday
var b object = "nope"
Console.WriteLine(Probe[DayOfWeek](a, DayOfWeek.Monday).ToString())
Console.WriteLine(Probe[DayOfWeek](b, DayOfWeek.Monday).ToString())`
        Assert.Equal("Wednesday${Environment.NewLine}Monday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func SwitchCasePattern_ClassConstrainedTypeParameter_StillUsesCastclass_Control() {
        // Test #5 (control) from the issue: a class-constrained generic type
        // parameter target must keep its existing (correct) castclass/
        // reference-type behavior — the fix must not perturb this path.
        let source = `package i2335classctrl
import System

open class Animal() {
    open func Speak() string -> "generic"
}
class Dog() : Animal() {
    override func Speak() string -> "Woof"
}

func F[T Animal](value object, fallback T) string {
    switch value {
        default { return "other" }
        case v is T { return v.Speak() }
    }
}

var a object = Dog()
var b object = "nope"
Console.WriteLine(F[Dog](a, Dog()))
Console.WriteLine(F[Dog](b, Dog()))`
        Assert.Equal("Woof${Environment.NewLine}other${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func SwitchCasePattern_UnconstrainedTypeParameter_ReferenceClosure_StillWorks_Control() {
        // Test #5 (control) from the issue: an UNCONSTRAINED type parameter
        // closed over a reference type must keep working exactly as before.
        let source = `package i2335unconstrctrl1
import System

func F[T](value object, fallback T) T {
    switch value {
        default { return fallback }
        case v is T { return v }
    }
}

var a object = "hello"
Console.WriteLine(F[string](a, "none"))`
        Assert.Equal("hello${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func SwitchCasePattern_UnconstrainedTypeParameter_ValueClosure_UnboxesCorrectly() {
        // Audit follow-up (see class remarks): an UNCONSTRAINED type
        // parameter closed over a VALUE type (`F[int32]`) previously emitted
        // `castclass !!T` for the pattern target — invalid IL, and (as
        // verified against pre-fix `main`) silently corrupted the observed
        // value at runtime rather than merely failing ilverify. Asserting the
        // exact numeric value (not just successful execution) pins down that
        // corruption.
        let source = `package i2335unconstrval
import System

func F[T](value object, fallback T) T {
    switch value {
        default { return fallback }
        case v is T { return v }
    }
}

var a object = 42
var b object = "nope"
Console.WriteLine(F[int32](a, -1))
Console.WriteLine(F[int32](b, -1))`
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OahuEnumConverterShape_ConvertToStructEnumConstrainedGeneric_MatchesAndConverts() {
        // Test #6 from the issue: the exact Oahu `EnumConverter<TEnum>` shape
        // (`open class ... [TEnum Enum struct] : TypeConverter` overriding
        // `ConvertTo` with `switch value { default {...}; case enm is TEnum
        // {...} }`), confirmed against the real Oahu.Foundation source during
        // the migration round that discovered this issue.
        let source = `package i2335oahuenumconv
import System
import System.ComponentModel
import System.Globalization

open class EnumConverterX[TEnum Enum struct] : TypeConverter {
    func ConvertTo(context ITypeDescriptorContext?, culture CultureInfo?, value object?, destinationType Type) object? {
        switch value {
            default {
                return base.ConvertTo(context, culture, value, destinationType)
            }
            case enm is TEnum {
                return enm.ToString()
            }
        }
    }
}

let conv = EnumConverterX[DayOfWeek]()
Console.WriteLine(conv.ConvertTo(nil, nil, DayOfWeek.Friday, typeof(string)))
Console.WriteLine(conv.ConvertTo(nil, nil, "hi", typeof(string)))`
        Assert.Equal(
            "Friday${Environment.NewLine}hi${Environment.NewLine}",
            CompileAndRun(source, requiresFullBcl: true)
        )
    }

    @Fact
    func OahuEnumChainConverterShape_TwoTypeParameters_MatchesAndConverts() {
        // Test #6 from the issue: the exact Oahu `EnumChainConverter<TEnum,
        // TPunct>` shape — TWO type parameters, the first `Enum, struct`
        // constrained (the pattern target) and the second class-constrained
        // with an `init()` constructor constraint, both declared on the same
        // `TypeConverter`-derived open class as EnumConverter above.
        let source = `package i2335oahuchainconv
import System
import System.ComponentModel
import System.Globalization

class Punct() {
}

open class EnumChainConverterX[TEnum Enum struct, TPunct Punct init()] : TypeConverter {
    func ConvertTo(context ITypeDescriptorContext?, culture CultureInfo?, value object?, destinationType Type) object? {
        switch value {
            default {
                return base.ConvertTo(context, culture, value, destinationType)
            }
            case enm is TEnum {
                return ToDisplayString(enm)
            }
        }
    }

    private func ToDisplayString(value TEnum) string -> value.ToString()
}

let conv = EnumChainConverterX[DayOfWeek, Punct]()
Console.WriteLine(conv.ConvertTo(nil, nil, DayOfWeek.Saturday, typeof(string)))
Console.WriteLine(conv.ConvertTo(nil, nil, "hi", typeof(string)))`
        Assert.Equal(
            "Saturday${Environment.NewLine}hi${Environment.NewLine}",
            CompileAndRun(source, requiresFullBcl: true)
        )
    }

    shared {
        private func CompileAndRun(source string, requiresFullBcl bool = false) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source, requiresFullBcl)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string, requiresFullBcl bool)(
            ExitCode int32,
            Stdout string,
            Stderr string
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_2335_struct_generic_pattern_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                if requiresFullBcl {
                    for bcl in BclReferences.Value {
                        args.Add("/r:" + bcl)
                    }
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let rtConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json")
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
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}

// <copyright file="Issue2333NarrowedNullAssertionEmitTests.cs" company="GSharp">
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

/// Issue #2333: a nullable value-type variable narrowed by a nil guard
/// (`if x == nil { ... } else { ... }`) already has its
/// `Nullable<T>` backing slot unwrapped by the binder's smart-cast
/// narrowing (`ExpressionBinder.BuildNarrowedRead`, issue #1547) —
/// a synthesized inner `!!` already spills to the slot and calls
/// `Nullable<T>::get_Value()`. A user-written `x!!` on top of
/// that narrowed read previously re-applied `EmitUnary`'s generic
/// reference-style `dup; brtrue` fallback to the already-unwrapped bare
/// value — invalid IL for floats/structs/generic value types (ilverify
/// `StackUnexpected`), and silently wrong for int/bool/enum "falsy but
/// non-null" values (`0`/`false`/first enum member), which would
/// incorrectly throw `NullReferenceException`.
///
/// The fix generalizes `EmitUnary`'s `NullAssertion` arm: any
/// operand whose static type is a bare (non-`NullableTypeSymbol`) value
/// type — primitive, BCL/user struct, enum, or a struct-constrained generic
/// type parameter — can never be a CLR `null`, so no runtime check is
/// emitted at all; the operand is passed through directly. This covers both
/// the narrowed-read shape above and a direct `!!` written on an
/// already non-nullable value. A second, related gap closed alongside it:
/// `Nullable<T>` over a struct-constrained open type parameter
/// (e.g. an `EnumConverter<T>`-style generic) had no CLR type to
/// build a BCL `get_Value` MemberRef from and fell into the same
/// invalid fallback (direct `!!`) or threw an internal
/// `InvalidOperationException` (null-conditional `?.` receiver
/// probe) — both now route through the existing symbolic TypeSpec-based
/// `get_Value` emission (`NullableLifting.RequiresSymbolicNullableGetValue`).
///
/// Every fact below fails to compile-verify (or crashes the compiler, or
/// silently misbehaves at runtime) on pre-fix `main` and passes after
/// the fix. Each test compiles with `gsc`, IL-verifies the produced PE,
/// then executes it and asserts on captured stdout — except where the test
/// documents an expected runtime exception (preserving #504's direct
/// nullable-value-type and reference-type null-assertion behavior).
open class Issue2333NarrowedNullAssertionEmitTests {
    @Fact
    func NarrowedFloat64_ElseBranchBangBang_ReturnsUnwrappedValue() {
        // The exact minimal repro from issue #2333.
        let source = `package i2333f64
import System

func F(x float64?, d float64) float64 {
    if x == nil {
        return d
    } else {
        return x!!
    }
}

Console.WriteLine(F(nil, -1.0))
Console.WriteLine(F(2.5, -1.0))
Console.WriteLine(F(0.0, -1.0))`
        Assert.Equal("-1${Environment.NewLine}2.5${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedFloat32_ElseBranchBangBang_ReturnsUnwrappedValue() {
        let source = `package i2333f32
import System

func F(x float32?, d float32) float32 {
    if x == nil {
        return d
    } else {
        return x!!
    }
}

Console.WriteLine(F(nil, -1.0f))
Console.WriteLine(F(3.5f, -1.0f))`
        Assert.Equal("-1${Environment.NewLine}3.5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedDateTime_ElseBranchBangBang_ReturnsUnwrappedValue() {
        // A BCL struct (System.DateTime) narrowed and unwrapped.
        let source = `package i2333datetime
import System

func F(x DateTime?, d DateTime) DateTime {
    if x == nil {
        return d
    } else {
        return x!!
    }
}

let epoch = DateTime(2000, 1, 1)
Console.WriteLine(F(nil, epoch) == epoch)
Console.WriteLine(F(epoch, DateTime(1999, 1, 1)) == epoch)`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedUserStruct_ElseBranchBangBang_ReturnsUnwrappedValue() {
        let source = `package i2333userstruct
import System

data struct Pt(X int32, Y int32)

func F(x Pt?, d Pt) Pt {
    if x == nil {
        return d
    } else {
        return x!!
    }
}

let fallback = Pt(-1, -1)
let r1 = F(nil, fallback)
let r2 = F(Pt(3, 4), fallback)
Console.WriteLine("${r1.X},${r1.Y}")
Console.WriteLine("${r2.X},${r2.Y}")`
        Assert.Equal("-1,-1${Environment.NewLine}3,4${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedUserEnum_ElseBranchBangBang_ReturnsUnwrappedValueEvenForFirstMember() {
        // Enum's first member (ordinal 0) is the "falsy" runtime representation
        // that the pre-fix `dup; brtrue` fallback misidentified as null.
        let source = `package i2333userenum
import System

enum ColorK { Red, Green, Blue }

func F(x ColorK?, d ColorK) ColorK {
    if x == nil {
        return d
    } else {
        return x!!
    }
}

Console.WriteLine(F(nil, ColorK.Blue))
Console.WriteLine(F(ColorK.Red, ColorK.Blue))
Console.WriteLine(F(ColorK.Green, ColorK.Blue))`
        Assert.Equal("2${Environment.NewLine}0${Environment.NewLine}1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedInt32ZeroValue_ElseBranchBangBang_ReturnsZero_DoesNotThrow() {
        // Regression guard: `0` is a legitimate non-null narrowed value.
        // Pre-fix, the `dup; brtrue` fallback branched on the VALUE (not
        // nullness) and incorrectly threw NullReferenceException for 0.
        let source = `package i2333int0
import System

func F(x int32?, d int32) int32 {
    if x == nil {
        return d
    } else {
        return x!!
    }
}

Console.WriteLine(F(0, -1))
Console.WriteLine(F(5, -1))
Console.WriteLine(F(nil, -1))`
        Assert.Equal("0${Environment.NewLine}5${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedBoolFalseValue_ElseBranchBangBang_ReturnsFalse_DoesNotThrow() {
        let source = `package i2333boolfalse
import System

func F(x bool?, d bool) bool {
    if x == nil {
        return d
    } else {
        return x!!
    }
}

Console.WriteLine(F(false, true))
Console.WriteLine(F(true, true))
Console.WriteLine(F(nil, true))`
        Assert.Equal(
            "False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NarrowedStructConstrainedGenericTypeParameter_ElseBranchBangBang_ReturnsUnwrappedValue() {
        // Generic `T?` (struct-constrained) narrowed then explicitly
        // asserted — the generalized shape behind #2333's "generic type
        // parameters" requirement.
        let source = `package i2333genericnarrow
import System

func F[T struct](x T?, d T) T {
    if x == nil {
        return d
    } else {
        return x!!
    }
}

Console.WriteLine(F[int32](nil, -1))
Console.WriteLine(F[int32](7, -1))
Console.WriteLine(F[float64](nil, -1.0))
Console.WriteLine(F[float64](2.25, -1.0))`
        Assert.Equal(
            "-1${Environment.NewLine}7${Environment.NewLine}-1${Environment.NewLine}2.25${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func DirectBangBang_OnStructConstrainedGenericNullable_NoNarrowing_UnwrapsAndThrows() {
        // Direct (non-narrowed) `!!` on `T?` where T is struct-constrained —
        // the EnumConverter<T>-style shape called out in the issue. No
        // ClrType is available for T at emit time, so the symbolic
        // Nullable<T>::get_Value MemberRef path must be used. Mirrors #504's
        // direct-nullable "throws InvalidOperationException on nil" contract.
        let source = `package i2333genericdirect
import System

func Unwrap[T struct](x T?) T {
    return x!!
}

Console.WriteLine(Unwrap[int32](9))
Console.WriteLine(Unwrap[float64](1.5))`
        Assert.Equal("9${Environment.NewLine}1.5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DirectBangBang_OnStructConstrainedGenericNullable_Nil_ThrowsInvalidOperationException() {
        let source = `package i2333genericdirectnil
import System

func Unwrap[T struct](x T?) T {
    return x!!
}

Console.WriteLine(Unwrap[int32](nil))`
        let (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("InvalidOperationException", stderr)
    }

    @Fact
    func NullConditionalAccess_OnStructConstrainedGenericNullableReceiver_DoesNotCrash() {
        // Sibling redundant-check path: the null-conditional (`?.`) receiver
        // probe had the same "no ClrType for a struct-constrained T"
        // omission and crashed the compiler with an internal
        // InvalidOperationException rather than emitting invalid IL.
        let source = `package i2333genericnullcond
import System

func Probe[T struct](x T?) int32? {
    return x?.GetHashCode()
}

Console.WriteLine(Probe[int32](5))
Console.WriteLine(Probe[int32](nil))`
        Assert.Equal("5${Environment.NewLine}${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DirectBangBang_OnNonNarrowedNullableValueType_Nil_StillThrowsInvalidOperationException() {
        // Preserves #504: a direct (non-narrowed) `!!` over a still-nullable
        // value type must keep its runtime null check.
        let source = `package i2333directnil
import System

func G(x float64?) float64 {
    return x!!
}

Console.WriteLine(G(nil))`
        let (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("InvalidOperationException", stderr)
    }

    @Fact
    func DirectBangBang_OnNonNarrowedNullableValueType_HasValue_ReturnsValue() {
        let source = `package i2333directvalue
import System

func G(x float64?) float64 {
    return x!!
}

Console.WriteLine(G(2.5))`
        Assert.Equal("2.5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DirectBangBang_OnReferenceType_Nil_StillThrowsNullReferenceException() {
        // Preserves reference-type `!!` runtime null checks.
        let source = `package i2333refnil
import System

func F(s string?) int32 {
    return s!!.Length
}

Console.WriteLine(F(nil))`
        let (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("NullReferenceException", stderr)
    }

    @Fact
    func DirectBangBang_OnReferenceType_NonNil_ReturnsValue() {
        let source = `package i2333refvalue
import System

func F(s string?) int32 {
    return s!!.Length
}

Console.WriteLine(F("abc"))`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OahuArgParserShape_FindFloatArgNarrowedThenBangBang_Runs() {
        // Real Oahu occurrence from the issue: ArgParser.FindFloatArg
        // narrows a `double? arg` via a nil guard, then reads `arg!!`.
        let source = `package i2333argparser
import System

func FindFloatArg(arg float64?) float64 {
    if arg == nil {
        return 0.0
    } else {
        return arg!!
    }
}

Console.WriteLine(FindFloatArg(nil))
Console.WriteLine(FindFloatArg(3.5))
Console.WriteLine(FindFloatArg(0.0))`
        Assert.Equal("0${Environment.NewLine}3.5${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OahuLogTmpFileMaintenanceShape_DateTimeNarrowedArithmetic_Runs() {
        // Real Oahu occurrence from the issue: LogTmpFileMaintenance narrows
        // a `DateTime?` last-run timestamp via a nil guard, then reads
        // `last!!` inside a `DateTime` subtraction.
        let source = `package i2333logtmpfile
import System

func ShouldRun(last DateTime?, now DateTime) bool {
    if last == nil {
        return true
    } else {
        let elapsed = now - last!!
        return elapsed.TotalSeconds > 3600.0
    }
}

let baseline = DateTime(2020, 1, 1, 0, 0, 0)
Console.WriteLine(ShouldRun(nil, baseline))
Console.WriteLine(ShouldRun(baseline, baseline))
Console.WriteLine(ShouldRun(baseline, baseline.AddHours(2.0)))`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NestedNarrowedFloat_MultipleReadsAndArithmetic_Runs() {
        // Multiple narrowed reads plus arithmetic in the narrowed branch —
        // guards against a fix that only handles a single top-level `!!`.
        let source = `package i2333nestedarith
import System

func Sum(x float64?) float64 {
    if x == nil {
        return 0.0
    } else {
        return x!! + x!! * 2.0
    }
}

Console.WriteLine(Sum(nil))
Console.WriteLine(Sum(3.0))`
        Assert.Equal("0${Environment.NewLine}9${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string, expectSuccess bool)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_2333_narrowed_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
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
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
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

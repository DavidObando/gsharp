// <copyright file="NullableLiftedBinaryOperatorEmitTests.cs" company="GSharp">
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

/// PR N-4 / §6.1 / C# §7.3.7: lifted binary operators over a value-type
/// `Nullable<T>`. Adds arithmetic / bitwise / equality /
/// ordering operators on `T?` using the same HasValue / get_Value
/// emit shape established by PR #541 (`!!`) and PR #544 (`??`).
///
/// These tests pin down the new behaviour:
/// - Lifted equality (`==` / `!=`): both null → true, one null → false, both present → underlying
/// equality.
/// - Lifted ordering (`<` / `<=` / `>` / `>=`): any null operand → false, otherwise underlying compare.
/// - Lifted arithmetic (`+ - * / %`): any null operand → nil result of type `R?`, otherwise wrap
/// `x.Value op y.Value` in a new `Nullable<R>`.
/// - Lifted bitwise (`& | ^`): same null-propagation shape, integer underlying.
/// - Mixed-mode (`T? op T` / `T op T?`): the binder implicitly lifts the non-nullable side to `T?` and
/// re-binds to the lifted operator.
/// - Existing `x? == nil` / `x? != nil` arm is not regressed (still handled by the dedicated
/// `IsNullCompare` path; not the lifted arm).
/// Each test compiles via `gsc`, runs `ilverify` against the
/// produced PE, then executes the assembly under `dotnet exec` and
/// asserts on the captured stdout (so any invalid IL surfaces as a
/// verification failure rather than silently passing).
open class NullableLiftedBinaryOperatorEmitTests {
    // ─────────────────────────── Equality ───────────────────────────
    @Fact
    func LiftedEquals_BothPresent_SameUnderlying_IsTrue() {
        let source = `package P
import System

var a int32? = 7
var b int32? = 7
Console.WriteLine(a == b)
Console.WriteLine(a != b)`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedEquals_BothPresent_DifferentUnderlying_IsFalse() {
        let source = `package P
import System

var a int32? = 7
var b int32? = 9
Console.WriteLine(a == b)
Console.WriteLine(a != b)`
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedEquals_BothNull_IsTrue() {
        let source = `package P
import System

var a int32? = nil
var b int32? = nil
Console.WriteLine(a == b)
Console.WriteLine(a != b)`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedEquals_OneNull_IsFalse() {
        let source = `package P
import System

var a int32? = 7
var b int32? = nil
Console.WriteLine(a == b)
Console.WriteLine(b == a)
Console.WriteLine(a != b)
Console.WriteLine(b != a)`
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func LiftedEquals_BoolNullable_FullMatrix() {
        let source = `package P
import System

var t bool? = true
var f bool? = false
var n bool? = nil
Console.WriteLine(t == t)
Console.WriteLine(t == f)
Console.WriteLine(t == n)
Console.WriteLine(n == n)
Console.WriteLine(t != t)
Console.WriteLine(n != f)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    // ─────────────────────────── Ordering ───────────────────────────
    @Fact
    func LiftedLess_BothPresent_UnderlyingCompare() {
        let source = `package P
import System

var a int32? = 3
var b int32? = 5
Console.WriteLine(a < b)
Console.WriteLine(b < a)
Console.WriteLine(a < a)
Console.WriteLine(a <= a)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func LiftedGreater_BothPresent_UnderlyingCompare() {
        let source = `package P
import System

var a int32? = 3
var b int32? = 5
Console.WriteLine(b > a)
Console.WriteLine(a > b)
Console.WriteLine(b >= b)
Console.WriteLine(a >= b)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func LiftedOrdering_AnyNull_IsFalse() {
        let source = `package P
import System

var a int32? = 3
var n int32? = nil
Console.WriteLine(a < n)
Console.WriteLine(n < a)
Console.WriteLine(n < n)
Console.WriteLine(a > n)
Console.WriteLine(a <= n)
Console.WriteLine(a >= n)`
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func LiftedOrdering_UnsignedUnderlying_UsesUnsignedCompare() {
        let source = `package P
import System

var a uint32? = uint32(1)
var b uint32? = uint32(4000000000u)
Console.WriteLine(a < b)
Console.WriteLine(b > a)`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    // ─────────────────────────── Arithmetic ─────────────────────────
    @Fact
    func LiftedSum_BothPresent_WrapsInNullable() {
        let source = `package P
import System

var a int32? = 3
var b int32? = 5
var s = a + b
Console.WriteLine(s ?? -1)`
        Assert.Equal("8${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedSum_AnyNull_ProducesNullableNil() {
        let source = `package P
import System

var a int32? = 3
var n int32? = nil
var s1 = a + n
var s2 = n + a
var s3 = n + n
Console.WriteLine(s1 ?? -1)
Console.WriteLine(s2 ?? -1)
Console.WriteLine(s3 ?? -1)`
        Assert.Equal("-1${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedSubtractAndMultiply_BothPresent() {
        let source = `package P
import System

var a int32? = 10
var b int32? = 4
var diff = a - b
var prod = a * b
Console.WriteLine(diff ?? 0)
Console.WriteLine(prod ?? 0)`
        Assert.Equal("6${Environment.NewLine}40${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedDivisionAndRemainder_BothPresent() {
        let source = `package P
import System

var a int32? = 17
var b int32? = 5
var q = a / b
var r = a % b
Console.WriteLine(q ?? -1)
Console.WriteLine(r ?? -1)`
        Assert.Equal("3${Environment.NewLine}2${Environment.NewLine}", CompileAndRun(source))
    }

    // ─────────────────────────── Bitwise ────────────────────────────
    @Fact
    func LiftedBitwise_BothPresent_IntegerSemantics() {
        let source = `package P
import System

var a int32? = 6
var b int32? = 3
var orV  = a | b
var andV = a & b
var xorV = a ^ b
Console.WriteLine(orV  ?? -1)
Console.WriteLine(andV ?? -1)
Console.WriteLine(xorV ?? -1)`
        Assert.Equal("7${Environment.NewLine}2${Environment.NewLine}5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedBitwise_NullPropagates() {
        let source = `package P
import System

var a int32? = 6
var n int32? = nil
var orV  = a | n
var andV = n & a
var xorV = n ^ n
Console.WriteLine(orV  ?? -1)
Console.WriteLine(andV ?? -1)
Console.WriteLine(xorV ?? -1)`
        Assert.Equal("-1${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", CompileAndRun(source))
    }

    // ─────────────────────────── Mixed-mode lift ────────────────────
    @Fact
    func MixedMode_NullableAndUnderlying_LiftsImplicitly() {
        // The binder lifts the non-nullable underlying to T? via the
        // existing implicit T -> T? conversion, then re-binds to the
        // lifted operator.
        let source = `package P
import System

var a int32? = 7
var s = a + 3
Console.WriteLine(s ?? -1)

var t = 3 + a
Console.WriteLine(t ?? -1)

Console.WriteLine(a == 7)
Console.WriteLine(7 == a)
Console.WriteLine(a < 9)
Console.WriteLine(3 < a)`
        Assert.Equal(
            "10${Environment.NewLine}10${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func MixedMode_NullableNullAndUnderlying_PropagatesAndIsFalse() {
        let source = `package P
import System

var n int32? = nil
var s = n + 3
Console.WriteLine(s ?? -1)
Console.WriteLine(n == 7)
Console.WriteLine(7 != n)
Console.WriteLine(n < 9)`
        Assert.Equal(
            "-1${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    // ─────────────────────────── Regression guards ─────────────────
    @Fact
    func NullableCompareAgainstNil_StillUsesNullCompareArm() {
        // Regression: the existing IsNullCompare arm handles `x? == nil`
        // and must continue to do so (it predates the lifted arm).
        let source = `package P
import System

var a int32? = 7
var n int32? = nil
Console.WriteLine(a == nil)
Console.WriteLine(a != nil)
Console.WriteLine(n == nil)
Console.WriteLine(n != nil)`
        Assert.Equal(
            "False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NonLiftedIntegerArithmetic_StillWorks() {
        // Regression: the non-lifted path (int32 + int32 -> int32) must
        // remain green. The lifted arm is only reachable when at least
        // one side is value-type Nullable<T>.
        let source = `package P
import System

var a int32 = 7
var b int32 = 3
Console.WriteLine(a + b)
Console.WriteLine(a == b)
Console.WriteLine(a > b)`
        Assert.Equal(
            "10${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NullableCoalesce_StillWorksAfterLift() {
        // Regression: PR #544's `??` lowering must still own value-type
        // Nullable<T> NullCoalesce — it is excluded from the lifted
        // collector and stays in receiverSpillSlots.
        let source = `package P
import System

var a int32? = 7
var n int32? = nil
Console.WriteLine(a ?? 99)
Console.WriteLine(n ?? 99)`
        Assert.Equal("7${Environment.NewLine}99${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        // ─────────────────────────── Helpers ───────────────────────────
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_nullable_lifted_").FullName
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

// <copyright file="Issue752ElvisNullableValueTypeEmitTests.cs" company="GSharp">
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

/// Issue #752 / ADR-0084 L3: the null-coalescing (`??`) operator over a value-type
/// `Nullable<T>` receiver. Issue #519 introduced the HasValue-based
/// emit path; this file pins down the exact patterns enumerated in #752 and
/// guards against regression in the cheaper `GetValueOrDefault()` shape
/// used on the non-null branch (no boxing, no callvirt, no redundant
/// HasValue/throw — the BCL property's predicate was just observed).
///
/// Each test compiles via `gsc`, runs `ilverify` against the
/// produced PE, then executes the assembly under `dotnet exec` and
/// asserts on the captured stdout. Invalid IL is surfaced as a verification
/// failure rather than silently passing.
open class Issue752ElvisNullableValueTypeEmitTests {
    @Fact
    func Elvis_NullableInt_LeftNil_ReturnsRightUnderlying() {
        // Canonical absent case: result type is the underlying `int32`.
        // Non-null branch reaches `GetValueOrDefault()` against the spill
        // slot; null branch evaluates the literal RHS.
        let source = `package P

import System

let v int32? = nil
let n = v ?? 0
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func Elvis_NullableInt_LeftPresent_ReturnsLeftUnderlying() {
        // Mirror of the absent case: HasValue is true, so the non-null
        // branch fires and `GetValueOrDefault()` returns 42 without the
        // BCL `get_Value` throw path.
        let source = `package P

import System

let v int32? = 42
let n = v ?? 0
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Elvis_NullableInt_Nested_BothNullableOperands_ChainsThroughRightArm() {
        // `(a ?? b) ?? 0` — both inner operands are `int32?`. The inner
        // expression's result is `int32?` (preserving wrapper shape per
        // existing typing rules), and the outer's result is `int32`.
        // Two separate spill slots are pre-allocated, one per BoundBinary.
        let source = `package P

import System

let a int32? = nil
let b int32? = 7
let n = (a ?? b) ?? 0
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func Elvis_NullableInt_Nested_AllNil_FallsThroughToLiteral() {
        // Same shape as above but every nullable arm is absent; the final
        // non-nullable literal must win.
        let source = `package P

import System

let a int32? = nil
let b int32? = nil
let n = (a ?? b) ?? 0
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func Elvis_ReferenceTypeString_RegressionGuard() {
        // Reference-typed nullables must continue to flow through the
        // existing `dup; brtrue; pop; rhs` short-circuit, which is legal
        // IL for object references. The value-type HasValue branch must
        // not capture this case (regression guard for the #752 fix).
        let source = `package P

import System

let s string? = nil
let r string = s ?? "missing"
Console.WriteLine(r)

let t string? = "hello"
let u string = t ?? "missing"
Console.WriteLine(u)`
        let output = CompileAndRun(source)
        Assert.Equal("missing${Environment.NewLine}hello${Environment.NewLine}", output)
    }

    @Fact
    func Elvis_NullableInt_LeftNil_BothArmsNullable_PreservesAbsenceShape() {
        // When both arms are `int32?`, the operator result type is the
        // wrapper. The HasValue==false path returns the RHS wrapper
        // unchanged; observed through `!!` here to assert the inner
        // value once the operator picked the RHS.
        let source = `package P

import System

let a int32? = nil
let b int32? = 99
let r int32? = a ?? b
Console.WriteLine(r!!)`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func Elvis_NullableInt_ReceiverOfInstanceCall_TakesAddressOfUnderlyingResult() {
        // Repro at the heart of #752: when the `??` result is the
        // receiver of an instance call on the underlying value type
        // (e.g. `.ToString()`), the emitter needs TWO distinct
        // scratch slots — a `Nullable<T>`-typed slot for the HasValue
        // spill and an underlying-`T`-typed slot for the receiver-
        // address spill. Before the fix, both purposes shared one
        // dictionary entry: the receiver-spill collector clobbered
        // the coalesce slot's type, producing invalid IL that the CLR
        // verifier rejected as `StackUnexpected` (the HasValue call's
        // receiver address pointed at an `int32` slot, not a
        // `Nullable<int32>` slot).
        let source = `package P

import System

let v int32? = 42
Console.WriteLine((v ?? -1).ToString())

let w int32? = nil
Console.WriteLine((w ?? -1).ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue752_").FullName
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

// <copyright file="Issue4184NullableParameterDelegateMatrixTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #4184 — the parameter-side sibling of the return-type nullable
/// erasure fixed for issue #4165 (see
/// `Emit.Issue1518NullableDelegateInferenceEmitTests`).
///
/// (cref:GSharp.Core.CodeAnalysis.Binding.Conversion.IsFunctionToDelegateConvertible)'s
/// parameter-compatibility fast path compared a method group's declared
/// parameter type against the delegate's declared parameter type using the
/// RAW `ClrType`. `NullableTypeSymbol.ClrType` erases a nullable
/// value type (`int32?`) to its bare underlying type (`int32`), so
/// a method declaring `int32?` was indistinguishable from one declaring
/// plain `int32` and silently satisfied a delegate slot declared
/// `int32` — a conversion `csc` rejects with `CS0123`.
///
/// <b>The fix</b> routes the comparison through
/// `NullableLifting.GetEffectiveClrType` (the same helper #4165 used for
/// the analogous RETURN-type erasure), which re-wraps a value-type underlying
/// in `Nullable[T]`. That alone was not sufficient: measured directly,
/// `Type.IsAssignableFrom` has its own CLR-level special case where
/// `Nullable<T>.IsAssignableFrom(T)` is `true`
/// (supporting the implicit `T -> T?` lift used in ordinary
/// expression contexts), which would have silently reintroduced this issue's
/// exact bug in the REVERSE direction (a method declaring bare `T`
/// wrongly satisfying a delegate slot declared `T?` — also
/// `CS0123` under `csc`) the moment the erasure stopped masking it.
/// A second, narrow guard (`IsClrNullableWideningMismatch`) closes that
/// too.
///
/// <b>The full T/T? parameter matrix</b>, each fact measured against `csc`
/// before being pinned here:
///
/// - `T -> T` ((cref:ParameterMatrix_NonNullableToNonNullable_CompilesAndRuns)): accepted.
/// - `T? -> T` ((cref:ParameterMatrix_NullableToNonNullable_IsRejected)): this issue's own repro,
/// rejected with `GS0155`.
/// - `T -> T?` ((cref:ParameterMatrix_NonNullableToNullable_IsRejected)): the reverse gap found while
/// building this matrix, rejected with `GS0155`.
/// - `T? -> T?` ((cref:ParameterMatrix_NullableToNullable_CompilesAndRuns)): accepted.
///
/// <b>Out of scope, filed separately.</b> The identical CLR
/// `Nullable<T>.IsAssignableFrom(T)` quirk also affects the RETURN
/// side's `T -> T?` direction for a bare METHOD GROUP (measured:
/// `func RTN(x int32) bool -> x != 0; var f Func[int32, bool?] = RTN`
/// still compiles on `gsc` where `csc` reports `CS0407`). It is
/// NOT fixed here: unlike the parameter side, `IsFunctionToDelegateConvertible`
/// is shared with LAMBDA return-type matching, where `csc` DOES accept a
/// `bool`-returning lambda body target-typed against `Func<int,
/// bool?>` (measured directly with `csc`) — applying the same
/// return-side guard without a method-group/lambda discriminator at this call
/// site risks regressing that legitimate lambda shape, so it is left for a
/// dedicated follow-up issue rather than half-fixed here.
open class Issue4184NullableParameterDelegateMatrixTests {
    @Fact
    func OriginalRepro_NullableValueTypeParameterMismatchesDelegate_IsRejected() {
        // The issue's own repro: `HasValue(x int32?)` cannot satisfy
        // `Func[int32, bool]` — csc measured: CS0123.
        const source = `package Issue4184Repro
import System

func HasValue(x int32?) bool -> x != nil

func Main() {
    var f Func[int32, bool] = HasValue
    Console.WriteLine(f(5))
}`
        let diagnostics = CompileExpectingFailure(source, "issue4184repro")
        Assert.Contains("GS0155", diagnostics)
    }

    @Fact
    func ParameterMatrix_NonNullableToNonNullable_CompilesAndRuns() {
        // T -> T: method declares bare int32, delegate declares bare int32.
        // csc measured: accepted.
        const source = `package Issue4184MatrixTT
import System

func TT(x int32) bool -> x != 0

func Main() {
    var f Func[int32, bool] = TT
    Console.WriteLine(f(5))
}`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source, "issue4184matrixtt"))
    }

    @Fact
    func ParameterMatrix_NullableToNonNullable_IsRejected() {
        // T? -> T: method declares int32?, delegate declares bare int32.
        // csc measured: CS0123. Same shape as the issue's own repro, with a
        // distinct package name to keep the FunctionTypeSymbol cache from
        // colliding with the other facts in this matrix.
        const source = `package Issue4184MatrixNT
import System

func NT(x int32?) bool -> x != nil

func Main() {
    var f Func[int32, bool] = NT
    Console.WriteLine(f(5))
}`
        let diagnostics = CompileExpectingFailure(source, "issue4184matrixnt")
        Assert.Contains("GS0155", diagnostics)
    }

    @Fact
    func ParameterMatrix_NonNullableToNullable_IsRejected() {
        // T -> T?: method declares bare int32, delegate declares int32?.
        // csc measured: CS0123 (the reverse-direction gap this fix closes
        // beyond the issue's literal repro).
        const source = `package Issue4184MatrixTN
import System

func TN(x int32) bool -> x != 0

func Main() {
    var f Func[int32?, bool] = TN
    Console.WriteLine(f(5))
}`
        let diagnostics = CompileExpectingFailure(source, "issue4184matrixtn")
        Assert.Contains("GS0155", diagnostics)
    }

    @Fact
    func ParameterMatrix_NullableToNullable_CompilesAndRuns() {
        // T? -> T?: method declares int32?, delegate declares int32?.
        // csc measured: accepted (identity match).
        const source = `package Issue4184MatrixNN
import System

func NN(x int32?) bool -> x != nil

func Main() {
    var f Func[int32?, bool] = NN
    Console.WriteLine(f(5))
}`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source, "issue4184matrixnn"))
    }

    @Fact
    func ReturnSideRegressionGuard_NullableReturnStillSatisfiesNonNullableDelegate_IsRejected() {
        // Guards against a regression of #4165's own return-side fix while
        // this issue's parameter-side fix lives in the same function: a
        // method returning bool? must not satisfy Func[int32, bool].
        const source = `package Issue4184ReturnGuardNT
import System

func NT(x int32) bool? -> x != 0

func Main() {
    var f Func[int32, bool] = NT
    Console.WriteLine(f(5))
}`
        let diagnostics = CompileExpectingFailure(source, "issue4184returnguardnt")
        Assert.Contains("GS0155", diagnostics)
    }

    shared {
        /// Compiles [`source`](paramref) and asserts it succeeds and runs,
        /// returning the process's captured stdout.
        private func CompileAndRun(source string, testName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_4184_" + testName + "_").FullName
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
                return stdout
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) {
                    // Best-effort cleanup; a concurrent agent sharing /tmp may
                    // still hold a handle.

                }
            }
        }

        /// Compiles [`source`](paramref), asserting it FAILS, and returns
        /// the captured diagnostic text (stdout + stderr).
        private func CompileExpectingFailure(source string, testName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_4184_" + testName + "_").FullName
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
                Assert.True(compileExit != 0, "expected gsc to fail, but it succeeded")
                return stdoutWriter.ToString() + stderrWriter.ToString()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) {
                    // Best-effort cleanup; a concurrent agent sharing /tmp may
                    // still hold a handle.

                }
            }
        }
    }
}

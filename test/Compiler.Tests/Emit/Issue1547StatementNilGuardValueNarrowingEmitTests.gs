// <copyright file="Issue1547StatementNilGuardValueNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1547 — narrowing a nullable VALUE type via an if-statement nil-guard
/// (`if v != nil { ... }`) previously emitted invalid IL. The if-statement
/// classifier (`StatementBinder.TryClassifyNilGuard`) accepts value-type
/// nullables (`int32?` = the CLR struct `System.Nullable<int32>`)
/// and narrows a read of `v` inside the block to the underlying `int32`.
/// But the storage slot holds a `Nullable<int32>`, so a bare narrowed
/// load left a `Nullable<T>` on the stack where `T` was expected,
/// failing ilverify with `[StackUnexpected] found Nullable`1<int32>,
/// expected Int32`.
///
/// The fix (`ExpressionBinder.BuildNarrowedRead`) wraps a narrowed
/// value-type-nullable read in a synthesized `!!`
/// (`BoundUnaryOperatorKind.NullAssertion`), reusing the proven value-type
/// unwrap emit path (spill → `Nullable<T>::get_Value`). The nil-guard
/// already proved the value non-nil, so the assertion never throws. Reference
/// nullables keep a bare narrowed read (a metadata no-op).
///
/// Every facet below fails ilverify on current main and passes after the fix.
/// Each uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed for user types.
open class Issue1547StatementNilGuardValueNarrowingEmitTests {
    @Fact
    func EndToEnd_Int32_ComparisonInGuard_Runs() {
        // The canonical issue #1547 repro: `if v != nil { return v > 0 }`.
        const source = `package i1547int32cmp
import System

func StmtNarrow(v int32?) bool {
    if v != nil { return v > 0 }
    return false
}

func Main() {
    Console.WriteLine(StmtNarrow(5))
    Console.WriteLine(StmtNarrow(-1))
    Console.WriteLine(StmtNarrow(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Int64_LetAssignArithmeticMultipleReads_Runs() {
        // `let x int64 = v` plus arithmetic over multiple narrowed reads.
        const source = `package i1547int64arith
import System

func Sum(v int64?) int64 {
    if v != nil {
        let x int64 = v
        return x + v + int64(1)
    }
    return int64(0)
}

func Main() {
    Console.WriteLine(Sum(int64(10)))
    Console.WriteLine(Sum(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("21${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_PlainReturnOfNarrowedValue_Runs() {
        // A bare `return v` (the narrowed value flowing straight through the
        // return conversion) must also unwrap.
        const source = `package i1547plainret
import System

func Unwrap(v int32?) int32 {
    if v != nil { return v }
    return -1
}

func Main() {
    Console.WriteLine(Unwrap(42))
    Console.WriteLine(Unwrap(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_PassNarrowedValueAsNonNullableArg_Runs() {
        // The narrowed value passed as a non-nullable `int32` argument.
        const source = `package i1547passarg
import System

func Twice(n int32) int32 -> n * 2

func Apply(v int32?) int32 {
    if v != nil { return Twice(v) }
    return 0
}

func Main() {
    Console.WriteLine(Apply(6))
    Console.WriteLine(Apply(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BoolCharDouble_UnderlyingTypes_Run() {
        // Generalize across several underlying value types and use sites.
        const source = `package i1547mixed
import System

func UseBool(v bool?) bool {
    if v != nil { return v }
    return false
}

func UseChar(v char?) char {
    if v != nil { return v }
    return 'z'
}

func UseDouble(v float64?) float64 {
    if v != nil {
        var total float64 = 0.0
        total = total + v
        total = total + v
        return total
    }
    return 0.0
}

func Main() {
    Console.WriteLine(UseBool(true))
    Console.WriteLine(UseChar('A'))
    Console.WriteLine(UseDouble(2.5))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}A${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NestedGuardBlocks_Run() {
        // Nested guarded blocks with multiple narrowed reads.
        const source = `package i1547nested
import System

func Nested(v int32?) int32 {
    if v != nil {
        if v > 0 {
            return v + 100
        }
        return v
    }
    return -1
}

func Main() {
    Console.WriteLine(Nested(5))
    Console.WriteLine(Nested(-3))
    Console.WriteLine(Nested(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("105${Environment.NewLine}-3${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ImportedValueTypeNullable_PassedAsArg_Runs() {
        // An imported/BCL value type (System.TimeSpan) narrowed and passed as a
        // non-nullable argument — the unwrap is not int32-specific.
        const source = `package i1547timespan
import System

func IsZero(t System.TimeSpan) bool -> t == System.TimeSpan.Zero

func Check(v System.TimeSpan?) bool {
    if v != nil { return IsZero(v) }
    return false
}

func Main() {
    Console.WriteLine(Check(System.TimeSpan.Zero))
    Console.WriteLine(Check(System.TimeSpan.FromSeconds(1.0)))
    Console.WriteLine(Check(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func Control_ReferenceNullable_StatementGuard_StillNarrows() {
        // Reference-type nullable narrowing is a metadata no-op and must keep
        // working (the fix must NOT wrap reference nullables in `!!`).
        const source = `package i1547refguard
import System

func Len(s string?) int32 {
    if s != nil { return s.Length }
    return -1
}

func Main() {
    Console.WriteLine(Len("abc"))
    Console.WriteLine(Len(nil))
}`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1547_exe_").FullName
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

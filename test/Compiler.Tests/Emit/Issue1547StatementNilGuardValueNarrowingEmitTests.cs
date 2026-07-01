// <copyright file="Issue1547StatementNilGuardValueNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1547 — narrowing a nullable VALUE type via an if-statement nil-guard
/// (<c>if v != nil { ... }</c>) previously emitted invalid IL. The if-statement
/// classifier (<c>StatementBinder.TryClassifyNilGuard</c>) accepts value-type
/// nullables (<c>int32?</c> = the CLR struct <c>System.Nullable&lt;int32&gt;</c>)
/// and narrows a read of <c>v</c> inside the block to the underlying <c>int32</c>.
/// But the storage slot holds a <c>Nullable&lt;int32&gt;</c>, so a bare narrowed
/// load left a <c>Nullable&lt;T&gt;</c> on the stack where <c>T</c> was expected,
/// failing ilverify with <c>[StackUnexpected] found Nullable`1&lt;int32&gt;,
/// expected Int32</c>.
/// <para>
/// The fix (<c>ExpressionBinder.BuildNarrowedRead</c>) wraps a narrowed
/// value-type-nullable read in a synthesized <c>!!</c>
/// (<c>BoundUnaryOperatorKind.NullAssertion</c>), reusing the proven value-type
/// unwrap emit path (spill → <c>Nullable&lt;T&gt;::get_Value</c>). The nil-guard
/// already proved the value non-nil, so the assertion never throws. Reference
/// nullables keep a bare narrowed read (a metadata no-op).
/// </para>
/// Every facet below fails ilverify on current main and passes after the fix.
/// Each uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed for user types.
/// </summary>
public class Issue1547StatementNilGuardValueNarrowingEmitTests
{
    [Fact]
    public void EndToEnd_Int32_ComparisonInGuard_Runs()
    {
        // The canonical issue #1547 repro: `if v != nil { return v > 0 }`.
        const string source = """
            package i1547int32cmp
            import System

            func StmtNarrow(v int32?) bool {
                if v != nil { return v > 0 }
                return false
            }

            func Main() {
                Console.WriteLine(StmtNarrow(5))
                Console.WriteLine(StmtNarrow(-1))
                Console.WriteLine(StmtNarrow(nil))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_Int64_LetAssignArithmeticMultipleReads_Runs()
    {
        // `let x int64 = v` plus arithmetic over multiple narrowed reads.
        const string source = """
            package i1547int64arith
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("21\n0\n", output);
    }

    [Fact]
    public void EndToEnd_PlainReturnOfNarrowedValue_Runs()
    {
        // A bare `return v` (the narrowed value flowing straight through the
        // return conversion) must also unwrap.
        const string source = """
            package i1547plainret
            import System

            func Unwrap(v int32?) int32 {
                if v != nil { return v }
                return -1
            }

            func Main() {
                Console.WriteLine(Unwrap(42))
                Console.WriteLine(Unwrap(nil))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n-1\n", output);
    }

    [Fact]
    public void EndToEnd_PassNarrowedValueAsNonNullableArg_Runs()
    {
        // The narrowed value passed as a non-nullable `int32` argument.
        const string source = """
            package i1547passarg
            import System

            func Twice(n int32) int32 -> n * 2

            func Apply(v int32?) int32 {
                if v != nil { return Twice(v) }
                return 0
            }

            func Main() {
                Console.WriteLine(Apply(6))
                Console.WriteLine(Apply(nil))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n0\n", output);
    }

    [Fact]
    public void EndToEnd_BoolCharDouble_UnderlyingTypes_Run()
    {
        // Generalize across several underlying value types and use sites.
        const string source = """
            package i1547mixed
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nA\n5\n", output);
    }

    [Fact]
    public void EndToEnd_NestedGuardBlocks_Run()
    {
        // Nested guarded blocks with multiple narrowed reads.
        const string source = """
            package i1547nested
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("105\n-3\n-1\n", output);
    }

    [Fact]
    public void EndToEnd_ImportedValueTypeNullable_PassedAsArg_Runs()
    {
        // An imported/BCL value type (System.TimeSpan) narrowed and passed as a
        // non-nullable argument — the unwrap is not int32-specific.
        const string source = """
            package i1547timespan
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\nFalse\n", output);
    }

    [Fact]
    public void Control_ReferenceNullable_StatementGuard_StillNarrows()
    {
        // Reference-type nullable narrowing is a metadata no-op and must keep
        // working (the fix must NOT wrap reference nullables in `!!`).
        const string source = """
            package i1547refguard
            import System

            func Len(s string?) int32 {
                if s != nil { return s.Length }
                return -1
            }

            func Main() {
                Console.WriteLine(Len("abc"))
                Console.WriteLine(Len(nil))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n-1\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1547_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}

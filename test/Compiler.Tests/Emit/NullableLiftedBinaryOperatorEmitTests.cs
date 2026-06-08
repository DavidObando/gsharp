// <copyright file="NullableLiftedBinaryOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// PR N-4 / §6.1 / C# §7.3.7: lifted binary operators over a value-type
/// <c>Nullable&lt;T&gt;</c>. Adds arithmetic / bitwise / equality /
/// ordering operators on <c>T?</c> using the same HasValue / get_Value
/// emit shape established by PR #541 (<c>!!</c>) and PR #544 (<c>?:</c>).
///
/// These tests pin down the new behaviour:
/// <list type="bullet">
///   <item>Lifted equality (<c>==</c> / <c>!=</c>): both null → true,
///   one null → false, both present → underlying equality.</item>
///   <item>Lifted ordering (<c>&lt;</c> / <c>&lt;=</c> / <c>&gt;</c> /
///   <c>&gt;=</c>): any null operand → false, otherwise underlying
///   compare.</item>
///   <item>Lifted arithmetic (<c>+ - * / %</c>): any null operand → nil
///   result of type <c>R?</c>, otherwise wrap <c>x.Value op y.Value</c>
///   in a new <c>Nullable&lt;R&gt;</c>.</item>
///   <item>Lifted bitwise (<c>&amp; | ^</c>): same null-propagation
///   shape, integer underlying.</item>
///   <item>Mixed-mode (<c>T? op T</c> / <c>T op T?</c>): the binder
///   implicitly lifts the non-nullable side to <c>T?</c> and re-binds
///   to the lifted operator.</item>
///   <item>Existing <c>x? == nil</c> / <c>x? != nil</c> arm is not
///   regressed (still handled by the dedicated <c>IsNullCompare</c>
///   path; not the lifted arm).</item>
/// </list>
/// Each test compiles via <c>gsc</c>, runs <c>ilverify</c> against the
/// produced PE, then executes the assembly under <c>dotnet exec</c> and
/// asserts on the captured stdout (so any invalid IL surfaces as a
/// verification failure rather than silently passing).
/// </summary>
public class NullableLiftedBinaryOperatorEmitTests
{
    // ─────────────────────────── Equality ───────────────────────────

    [Fact]
    public void LiftedEquals_BothPresent_SameUnderlying_IsTrue()
    {
        var source = """
            package P
            import System

            var a int32? = 7
            var b int32? = 7
            Console.WriteLine(a == b)
            Console.WriteLine(a != b)
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedEquals_BothPresent_DifferentUnderlying_IsFalse()
    {
        var source = """
            package P
            import System

            var a int32? = 7
            var b int32? = 9
            Console.WriteLine(a == b)
            Console.WriteLine(a != b)
            """;

        Assert.Equal("False\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedEquals_BothNull_IsTrue()
    {
        var source = """
            package P
            import System

            var a int32? = nil
            var b int32? = nil
            Console.WriteLine(a == b)
            Console.WriteLine(a != b)
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedEquals_OneNull_IsFalse()
    {
        var source = """
            package P
            import System

            var a int32? = 7
            var b int32? = nil
            Console.WriteLine(a == b)
            Console.WriteLine(b == a)
            Console.WriteLine(a != b)
            Console.WriteLine(b != a)
            """;

        Assert.Equal("False\nFalse\nTrue\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedEquals_BoolNullable_FullMatrix()
    {
        var source = """
            package P
            import System

            var t bool? = true
            var f bool? = false
            var n bool? = nil
            Console.WriteLine(t == t)
            Console.WriteLine(t == f)
            Console.WriteLine(t == n)
            Console.WriteLine(n == n)
            Console.WriteLine(t != t)
            Console.WriteLine(n != f)
            """;

        Assert.Equal("True\nFalse\nFalse\nTrue\nFalse\nTrue\n", CompileAndRun(source));
    }

    // ─────────────────────────── Ordering ───────────────────────────

    [Fact]
    public void LiftedLess_BothPresent_UnderlyingCompare()
    {
        var source = """
            package P
            import System

            var a int32? = 3
            var b int32? = 5
            Console.WriteLine(a < b)
            Console.WriteLine(b < a)
            Console.WriteLine(a < a)
            Console.WriteLine(a <= a)
            """;

        Assert.Equal("True\nFalse\nFalse\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedGreater_BothPresent_UnderlyingCompare()
    {
        var source = """
            package P
            import System

            var a int32? = 3
            var b int32? = 5
            Console.WriteLine(b > a)
            Console.WriteLine(a > b)
            Console.WriteLine(b >= b)
            Console.WriteLine(a >= b)
            """;

        Assert.Equal("True\nFalse\nTrue\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedOrdering_AnyNull_IsFalse()
    {
        var source = """
            package P
            import System

            var a int32? = 3
            var n int32? = nil
            Console.WriteLine(a < n)
            Console.WriteLine(n < a)
            Console.WriteLine(n < n)
            Console.WriteLine(a > n)
            Console.WriteLine(a <= n)
            Console.WriteLine(a >= n)
            """;

        Assert.Equal("False\nFalse\nFalse\nFalse\nFalse\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedOrdering_UnsignedUnderlying_UsesUnsignedCompare()
    {
        var source = """
            package P
            import System

            var a uint32? = uint32(1)
            var b uint32? = uint32(4000000000u)
            Console.WriteLine(a < b)
            Console.WriteLine(b > a)
            """;

        Assert.Equal("True\nTrue\n", CompileAndRun(source));
    }

    // ─────────────────────────── Arithmetic ─────────────────────────

    [Fact]
    public void LiftedSum_BothPresent_WrapsInNullable()
    {
        var source = """
            package P
            import System

            var a int32? = 3
            var b int32? = 5
            var s = a + b
            Console.WriteLine(s ?: -1)
            """;

        Assert.Equal("8\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedSum_AnyNull_ProducesNullableNil()
    {
        var source = """
            package P
            import System

            var a int32? = 3
            var n int32? = nil
            var s1 = a + n
            var s2 = n + a
            var s3 = n + n
            Console.WriteLine(s1 ?: -1)
            Console.WriteLine(s2 ?: -1)
            Console.WriteLine(s3 ?: -1)
            """;

        Assert.Equal("-1\n-1\n-1\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedSubtractAndMultiply_BothPresent()
    {
        var source = """
            package P
            import System

            var a int32? = 10
            var b int32? = 4
            var diff = a - b
            var prod = a * b
            Console.WriteLine(diff ?: 0)
            Console.WriteLine(prod ?: 0)
            """;

        Assert.Equal("6\n40\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedDivisionAndRemainder_BothPresent()
    {
        var source = """
            package P
            import System

            var a int32? = 17
            var b int32? = 5
            var q = a / b
            var r = a % b
            Console.WriteLine(q ?: -1)
            Console.WriteLine(r ?: -1)
            """;

        Assert.Equal("3\n2\n", CompileAndRun(source));
    }

    // ─────────────────────────── Bitwise ────────────────────────────

    [Fact]
    public void LiftedBitwise_BothPresent_IntegerSemantics()
    {
        var source = """
            package P
            import System

            var a int32? = 6
            var b int32? = 3
            var orV  = a | b
            var andV = a & b
            var xorV = a ^ b
            Console.WriteLine(orV  ?: -1)
            Console.WriteLine(andV ?: -1)
            Console.WriteLine(xorV ?: -1)
            """;

        Assert.Equal("7\n2\n5\n", CompileAndRun(source));
    }

    [Fact]
    public void LiftedBitwise_NullPropagates()
    {
        var source = """
            package P
            import System

            var a int32? = 6
            var n int32? = nil
            var orV  = a | n
            var andV = n & a
            var xorV = n ^ n
            Console.WriteLine(orV  ?: -1)
            Console.WriteLine(andV ?: -1)
            Console.WriteLine(xorV ?: -1)
            """;

        Assert.Equal("-1\n-1\n-1\n", CompileAndRun(source));
    }

    // ─────────────────────────── Mixed-mode lift ────────────────────

    [Fact]
    public void MixedMode_NullableAndUnderlying_LiftsImplicitly()
    {
        // The binder lifts the non-nullable underlying to T? via the
        // existing implicit T -> T? conversion, then re-binds to the
        // lifted operator.
        var source = """
            package P
            import System

            var a int32? = 7
            var s = a + 3
            Console.WriteLine(s ?: -1)

            var t = 3 + a
            Console.WriteLine(t ?: -1)

            Console.WriteLine(a == 7)
            Console.WriteLine(7 == a)
            Console.WriteLine(a < 9)
            Console.WriteLine(3 < a)
            """;

        Assert.Equal("10\n10\nTrue\nTrue\nTrue\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void MixedMode_NullableNullAndUnderlying_PropagatesAndIsFalse()
    {
        var source = """
            package P
            import System

            var n int32? = nil
            var s = n + 3
            Console.WriteLine(s ?: -1)
            Console.WriteLine(n == 7)
            Console.WriteLine(7 != n)
            Console.WriteLine(n < 9)
            """;

        Assert.Equal("-1\nFalse\nTrue\nFalse\n", CompileAndRun(source));
    }

    // ─────────────────────────── Regression guards ─────────────────

    [Fact]
    public void NullableCompareAgainstNil_StillUsesNullCompareArm()
    {
        // Regression: the existing IsNullCompare arm handles `x? == nil`
        // and must continue to do so (it predates the lifted arm).
        var source = """
            package P
            import System

            var a int32? = 7
            var n int32? = nil
            Console.WriteLine(a == nil)
            Console.WriteLine(a != nil)
            Console.WriteLine(n == nil)
            Console.WriteLine(n != nil)
            """;

        Assert.Equal("False\nTrue\nTrue\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void NonLiftedIntegerArithmetic_StillWorks()
    {
        // Regression: the non-lifted path (int32 + int32 -> int32) must
        // remain green. The lifted arm is only reachable when at least
        // one side is value-type Nullable<T>.
        var source = """
            package P
            import System

            var a int32 = 7
            var b int32 = 3
            Console.WriteLine(a + b)
            Console.WriteLine(a == b)
            Console.WriteLine(a > b)
            """;

        Assert.Equal("10\nFalse\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NullableCoalesce_StillWorksAfterLift()
    {
        // Regression: PR #544's `?:` lowering must still own value-type
        // Nullable<T> NullCoalesce — it is excluded from the lifted
        // collector and stays in receiverSpillSlots.
        var source = """
            package P
            import System

            var a int32? = 7
            var n int32? = nil
            Console.WriteLine(a ?: 99)
            Console.WriteLine(n ?: 99)
            """;

        Assert.Equal("7\n99\n", CompileAndRun(source));
    }

    // ─────────────────────────── Helpers ───────────────────────────

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_nullable_lifted_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

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

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}

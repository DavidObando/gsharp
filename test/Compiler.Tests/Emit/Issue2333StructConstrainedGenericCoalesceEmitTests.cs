// <copyright file="Issue2333StructConstrainedGenericCoalesceEmitTests.cs" company="GSharp">
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
/// Issue #2333 (follow-up): completes the sibling-path audit for
/// <c>Nullable&lt;T&gt;</c> where <c>T</c> is an open type parameter
/// constrained to <c>struct</c> (e.g. an <c>EnumConverter&lt;T&gt;</c>-style
/// generic). The <c>!!</c> and <c>?.</c> emit paths were fixed first; this
/// closes the matching gap in the <c>??</c> (null-coalescing) emitter arm.
///
/// <para>
/// Pre-fix, <c>EmitBinary</c>'s <c>NullCoalesce</c> handling recognized
/// value-type <c>Nullable&lt;T&gt;</c> LHS operands only via a runtime
/// <c>ClrType</c> probe (issue #519) or the same-compilation
/// <c>IsUserValueTypeNullable</c> check (struct/enum, issue #1578) — neither
/// matches a struct-constrained open type parameter, whose <c>Nullable&lt;T&gt;</c>
/// instantiation has no resolvable host <c>Type</c>. The defensive fallback
/// at the bottom of the <c>??</c> arm caught this specific shape and threw a
/// documented <see cref="NotSupportedException"/> rather than emitting
/// invalid IL — safe, but an unimplemented gap.
/// </para>
///
/// <para>
/// The fix widens the existing #1578 arm's guard from
/// <c>NullableLifting.IsUserValueTypeNullable</c> to
/// <c>NullableLifting.RequiresSymbolicNullableGetValue</c> — the same
/// predicate the #2333 <c>!!</c>/<c>?.</c> fix introduced — so the
/// struct-constrained-generic shape reuses the exact same box-probe /
/// symbolic <c>get_Value</c> MemberRef machinery already proven for user
/// structs/enums, rather than adding a new special case. No other emitter
/// code changed: <c>ReflectionMetadataEmitter.GetElementTypeToken</c> and
/// <c>GetNullableGetValueMemberRefForUserValueType</c> already handled this
/// TypeSpec shape (issues #814 / #2333).
/// </para>
///
/// <para>
/// Each test compiles via <c>gsc</c>, IL-verifies the produced PE, then
/// executes it and asserts on captured stdout, except where the test
/// documents an expected compile-time diagnostic or an already-safe
/// <see cref="NotSupportedException"/> (there are none remaining — this
/// file exists to prove the gap is now closed end-to-end).
/// </para>
/// </summary>
public class Issue2333StructConstrainedGenericCoalesceEmitTests
{
    [Fact]
    public void StructConstrainedGeneric_NilOperand_TakesFallback()
    {
        var source = """
            package i2333gcoalesce1
            import System

            func Coalesce[T struct](x T?, fallback T) T {
                return x ?? fallback
            }

            Console.WriteLine(Coalesce[int32](nil, -1))
            """;

        Assert.Equal("-1\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGeneric_PresentOperand_TakesValue()
    {
        var source = """
            package i2333gcoalesce2
            import System

            func Coalesce[T struct](x T?, fallback T) T {
                return x ?? fallback
            }

            Console.WriteLine(Coalesce[int32](7, -1))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGeneric_Float64Instantiation_NilAndPresent()
    {
        var source = """
            package i2333gcoalesce3
            import System

            func Coalesce[T struct](x T?, fallback T) T {
                return x ?? fallback
            }

            Console.WriteLine(Coalesce[float64](nil, -1.0))
            Console.WriteLine(Coalesce[float64](2.25, -1.0))
            """;

        Assert.Equal("-1\n2.25\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGeneric_BclStructInstantiation_DateTime_NilAndPresent()
    {
        var source = """
            package i2333gcoalesce4
            import System

            func Coalesce[T struct](x T?, fallback T) T {
                return x ?? fallback
            }

            let fb = DateTime(2000, 1, 1)
            let present = DateTime(2020, 6, 15)
            Console.WriteLine(Coalesce[DateTime](nil, fb).Year)
            Console.WriteLine(Coalesce[DateTime](present, fb).Year)
            """;

        Assert.Equal("2000\n2020\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGeneric_UserStructInstantiation_NilAndPresent()
    {
        var source = """
            package i2333gcoalesce5
            import System

            struct GcPt { var x int32 }

            func Coalesce[T struct](x T?, fallback T) T {
                return x ?? fallback
            }

            let fb = GcPt{x: -1}
            let present = GcPt{x: 9}
            Console.WriteLine(Coalesce[GcPt](nil, fb).x)
            Console.WriteLine(Coalesce[GcPt](present, fb).x)
            """;

        Assert.Equal("-1\n9\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGeneric_FalsyButPresentValues_Int32ZeroAndBoolFalse()
    {
        // Ordinal/falsy-but-present values (int32 `0`, bool `false`) are
        // legitimate present values, not "null" — exercises the same
        // falsy-value-correctness concern as the sibling `!!` fix, this
        // time through the `??` box-probe (which correctly distinguishes
        // an empty Nullable<T> from a boxed falsy-but-present T via
        // Nullable<T>'s own box semantics, never via `dup; brtrue` on the
        // unwrapped value).
        var source = """
            package i2333gcoalesce6
            import System

            func CoalesceInt[T struct](x T?, fallback T) T {
                return x ?? fallback
            }

            Console.WriteLine(CoalesceInt[int32](0, -1))
            Console.WriteLine(CoalesceInt[int32](nil, -1))
            Console.WriteLine(CoalesceInt[bool](false, true))
            Console.WriteLine(CoalesceInt[bool](nil, true))
            """;

        Assert.Equal("0\n-1\nFalse\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGeneric_NullableResultChain_ReloadsWrapper()
    {
        // `(v ?? w) ?? fallback` — the inner coalesce's result stays
        // `Nullable<T>`, so the outer coalesce must reload the wrapper
        // (not unwrap) on its non-null branch. Mirrors the BCL/user-struct
        // "NullableResultBranchReloadsWrapper" coverage for the
        // struct-constrained generic shape.
        var source = """
            package i2333gcoalesce7
            import System

            func Chain[T struct](v T?, w T?, fallback T) T {
                return (v ?? w) ?? fallback
            }

            Console.WriteLine(Chain[int32](nil, nil, -9))
            Console.WriteLine(Chain[int32](nil, 5, -9))
            Console.WriteLine(Chain[int32](3, nil, -9))
            """;

        Assert.Equal("-9\n5\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGeneric_Coalesce_EvaluatesLhsExactlyOnce()
    {
        // Evaluation-once semantics: the LHS is a call with an observable
        // side effect (increments a counter). Regardless of which branch
        // (nil or present) is taken, the LHS must be evaluated exactly once
        // — the box-probe spills to a local rather than re-evaluating the
        // LHS expression for the HasValue probe and the unwrap/reload.
        var source = """
            package i2333gcoalesce8
            import System

            var counter int32 = 0

            func GetNilable[T struct](x T?) T? {
                counter = counter + 1
                return x
            }

            func Coalesce[T struct](x T?, fallback T) T {
                return GetNilable[T](x) ?? fallback
            }

            Console.WriteLine(Coalesce[int32](nil, 42))
            Console.WriteLine(counter)
            counter = 0
            Console.WriteLine(Coalesce[int32](7, 42))
            Console.WriteLine(counter)
            """;

        Assert.Equal("42\n1\n7\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void StructConstrainedGeneric_NullCoalescingAssignment_DoesNotShareThisPath_AlreadyWorks()
    {
        // Audit finding: `??=` lowers (in the binder) to a plain
        // `if (read == nil) { write = rhs; }` using the standard `== nil`
        // comparison operator — a different code path from the
        // `BoundBinaryExpression(NullCoalesce)` `??` operator emit arm this
        // change touches. It was already correct for this shape (the
        // narrowing/equality infra was fixed independently of #2333), so no
        // source change was needed; this test locks in that observation.
        var source = """
            package i2333gcoalesceassign
            import System

            func WithDefault[T struct](fallback T) T? {
                var x T? = nil
                x ??= fallback
                return x
            }

            func KeepsPresent[T struct](initial T, fallback T) T? {
                var x T? = initial
                x ??= fallback
                return x
            }

            Console.WriteLine(WithDefault[int32](9)!!)
            Console.WriteLine(KeepsPresent[int32](3, 9)!!)
            """;

        Assert.Equal("9\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void NegativeControl_ClassConstrainedGeneric_Coalesce_StillUsesIssue831Path()
    {
        // Negative control: a CLASS-constrained (or unconstrained)
        // `Nullable<T>` (bare `!!T` storage, not `Nullable<T>` struct) must
        // keep using the existing #831 box-probe arm — RequiresSymbolicNullableGetValue
        // is false for a non-struct-constrained type parameter, so this
        // shape is untouched by the #2333 widening.
        var source = """
            package i2333gcoalesceneg1
            import System

            func OrElse[T class](self T?, defaultValue T) T {
                return self ?? defaultValue
            }

            var present string? = "value"
            var absent string? = nil
            Console.WriteLine(OrElse(present, "fallback"))
            Console.WriteLine(OrElse(absent, "fallback"))
            """;

        Assert.Equal("value\nfallback\n", CompileAndRun(source));
    }

    [Fact]
    public void NegativeControl_UnconstrainedTypeParameterAsCast_Coalesce_StillUsesIssue1516Path()
    {
        // Negative control: a bare reference-typed type parameter (from
        // `x as T`, not wrapped in NullableTypeSymbol at all) must keep
        // using the existing #1516 box-probe arm, unaffected by this change.
        var source = """
            package i2333gcoalesceneg2
            import System

            func Get[T](src object, fallback T) T {
                return src as T ?? fallback
            }

            var s object = "hi"
            var n object = 5
            Console.WriteLine(Get[string](s, "fb"))
            Console.WriteLine(Get[string](n, "fb"))
            """;

        Assert.Equal("hi\nfb\n", CompileAndRun(source));
    }

    [Fact]
    public void NegativeControl_PrimitiveNullable_Coalesce_StillUsesIssue519Path()
    {
        // Negative control: a plain BCL/primitive `int32?` LHS must keep
        // using the ClrType-based #519 get_HasValue arm, unaffected.
        var source = """
            package i2333gcoalesceneg3
            import System

            func Coalesce(v int32?) int32 { return v ?? -1 }

            let none int32? = nil
            let some int32? = 8
            Console.WriteLine(Coalesce(none))
            Console.WriteLine(Coalesce(some))
            """;

        Assert.Equal("-1\n8\n", CompileAndRun(source));
    }

    [Fact]
    public void NegativeControl_ReferenceTypeNullable_Coalesce_StillUsesDupBrtruePath()
    {
        // Negative control: a plain reference-type nullable (string?) LHS
        // must keep using the bottom `dup; brtrue; pop; rhs` shape,
        // unaffected by this change.
        var source = """
            package i2333gcoalesceneg4
            import System

            func Coalesce(v string?) string { return v ?? "fallback" }

            var none string? = nil
            var some string? = "present"
            Console.WriteLine(Coalesce(none))
            Console.WriteLine(Coalesce(some))
            """;

        Assert.Equal("fallback\npresent\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2333_gcoalesce_").FullName;
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
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
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

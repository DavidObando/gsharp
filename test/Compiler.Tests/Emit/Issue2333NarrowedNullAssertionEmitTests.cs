// <copyright file="Issue2333NarrowedNullAssertionEmitTests.cs" company="GSharp">
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
/// Issue #2333: a nullable value-type variable narrowed by a nil guard
/// (<c>if x == nil { ... } else { ... }</c>) already has its
/// <c>Nullable&lt;T&gt;</c> backing slot unwrapped by the binder's smart-cast
/// narrowing (<c>ExpressionBinder.BuildNarrowedRead</c>, issue #1547) —
/// a synthesized inner <c>!!</c> already spills to the slot and calls
/// <c>Nullable&lt;T&gt;::get_Value()</c>. A user-written <c>x!!</c> on top of
/// that narrowed read previously re-applied <c>EmitUnary</c>'s generic
/// reference-style <c>dup; brtrue</c> fallback to the already-unwrapped bare
/// value — invalid IL for floats/structs/generic value types (ilverify
/// <c>StackUnexpected</c>), and silently wrong for int/bool/enum "falsy but
/// non-null" values (<c>0</c>/<c>false</c>/first enum member), which would
/// incorrectly throw <c>NullReferenceException</c>.
///
/// <para>
/// The fix generalizes <c>EmitUnary</c>'s <c>NullAssertion</c> arm: any
/// operand whose static type is a bare (non-<c>NullableTypeSymbol</c>) value
/// type — primitive, BCL/user struct, enum, or a struct-constrained generic
/// type parameter — can never be a CLR <c>null</c>, so no runtime check is
/// emitted at all; the operand is passed through directly. This covers both
/// the narrowed-read shape above and a direct <c>!!</c> written on an
/// already non-nullable value. A second, related gap closed alongside it:
/// <c>Nullable&lt;T&gt;</c> over a struct-constrained open type parameter
/// (e.g. an <c>EnumConverter&lt;T&gt;</c>-style generic) had no CLR type to
/// build a BCL <c>get_Value</c> MemberRef from and fell into the same
/// invalid fallback (direct <c>!!</c>) or threw an internal
/// <c>InvalidOperationException</c> (null-conditional <c>?.</c> receiver
/// probe) — both now route through the existing symbolic TypeSpec-based
/// <c>get_Value</c> emission (<c>NullableLifting.RequiresSymbolicNullableGetValue</c>).
/// </para>
///
/// <para>
/// Every fact below fails to compile-verify (or crashes the compiler, or
/// silently misbehaves at runtime) on pre-fix <c>main</c> and passes after
/// the fix. Each test compiles with <c>gsc</c>, IL-verifies the produced PE,
/// then executes it and asserts on captured stdout — except where the test
/// documents an expected runtime exception (preserving #504's direct
/// nullable-value-type and reference-type null-assertion behavior).
/// </para>
/// </summary>
public class Issue2333NarrowedNullAssertionEmitTests
{
    [Fact]
    public void NarrowedFloat64_ElseBranchBangBang_ReturnsUnwrappedValue()
    {
        // The exact minimal repro from issue #2333.
        var source = """
            package i2333f64
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
            Console.WriteLine(F(0.0, -1.0))
            """;

        Assert.Equal("-1\n2.5\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedFloat32_ElseBranchBangBang_ReturnsUnwrappedValue()
    {
        var source = """
            package i2333f32
            import System

            func F(x float32?, d float32) float32 {
                if x == nil {
                    return d
                } else {
                    return x!!
                }
            }

            Console.WriteLine(F(nil, -1.0f))
            Console.WriteLine(F(3.5f, -1.0f))
            """;

        Assert.Equal("-1\n3.5\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedDateTime_ElseBranchBangBang_ReturnsUnwrappedValue()
    {
        // A BCL struct (System.DateTime) narrowed and unwrapped.
        var source = """
            package i2333datetime
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
            Console.WriteLine(F(epoch, DateTime(1999, 1, 1)) == epoch)
            """;

        Assert.Equal("True\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedUserStruct_ElseBranchBangBang_ReturnsUnwrappedValue()
    {
        var source = """
            package i2333userstruct
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
            Console.WriteLine("${r2.X},${r2.Y}")
            """;

        Assert.Equal("-1,-1\n3,4\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedUserEnum_ElseBranchBangBang_ReturnsUnwrappedValueEvenForFirstMember()
    {
        // Enum's first member (ordinal 0) is the "falsy" runtime representation
        // that the pre-fix `dup; brtrue` fallback misidentified as null.
        var source = """
            package i2333userenum
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
            Console.WriteLine(F(ColorK.Green, ColorK.Blue))
            """;

        Assert.Equal("2\n0\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedInt32ZeroValue_ElseBranchBangBang_ReturnsZero_DoesNotThrow()
    {
        // Regression guard: `0` is a legitimate non-null narrowed value.
        // Pre-fix, the `dup; brtrue` fallback branched on the VALUE (not
        // nullness) and incorrectly threw NullReferenceException for 0.
        var source = """
            package i2333int0
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
            Console.WriteLine(F(nil, -1))
            """;

        Assert.Equal("0\n5\n-1\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedBoolFalseValue_ElseBranchBangBang_ReturnsFalse_DoesNotThrow()
    {
        var source = """
            package i2333boolfalse
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
            Console.WriteLine(F(nil, true))
            """;

        Assert.Equal("False\nTrue\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedStructConstrainedGenericTypeParameter_ElseBranchBangBang_ReturnsUnwrappedValue()
    {
        // Generic `T?` (struct-constrained) narrowed then explicitly
        // asserted — the generalized shape behind #2333's "generic type
        // parameters" requirement.
        var source = """
            package i2333genericnarrow
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
            Console.WriteLine(F[float64](2.25, -1.0))
            """;

        Assert.Equal("-1\n7\n-1\n2.25\n", CompileAndRun(source));
    }

    [Fact]
    public void DirectBangBang_OnStructConstrainedGenericNullable_NoNarrowing_UnwrapsAndThrows()
    {
        // Direct (non-narrowed) `!!` on `T?` where T is struct-constrained —
        // the EnumConverter<T>-style shape called out in the issue. No
        // ClrType is available for T at emit time, so the symbolic
        // Nullable<T>::get_Value MemberRef path must be used. Mirrors #504's
        // direct-nullable "throws InvalidOperationException on nil" contract.
        var source = """
            package i2333genericdirect
            import System

            func Unwrap[T struct](x T?) T {
                return x!!
            }

            Console.WriteLine(Unwrap[int32](9))
            Console.WriteLine(Unwrap[float64](1.5))
            """;

        Assert.Equal("9\n1.5\n", CompileAndRun(source));
    }

    [Fact]
    public void DirectBangBang_OnStructConstrainedGenericNullable_Nil_ThrowsInvalidOperationException()
    {
        var source = """
            package i2333genericdirectnil
            import System

            func Unwrap[T struct](x T?) T {
                return x!!
            }

            Console.WriteLine(Unwrap[int32](nil))
            """;

        var (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("InvalidOperationException", stderr);
    }

    [Fact]
    public void NullConditionalAccess_OnStructConstrainedGenericNullableReceiver_DoesNotCrash()
    {
        // Sibling redundant-check path: the null-conditional (`?.`) receiver
        // probe had the same "no ClrType for a struct-constrained T"
        // omission and crashed the compiler with an internal
        // InvalidOperationException rather than emitting invalid IL.
        var source = """
            package i2333genericnullcond
            import System

            func Probe[T struct](x T?) int32? {
                return x?.GetHashCode()
            }

            Console.WriteLine(Probe[int32](5))
            Console.WriteLine(Probe[int32](nil))
            """;

        Assert.Equal("5\n\n", CompileAndRun(source));
    }

    [Fact]
    public void DirectBangBang_OnNonNarrowedNullableValueType_Nil_StillThrowsInvalidOperationException()
    {
        // Preserves #504: a direct (non-narrowed) `!!` over a still-nullable
        // value type must keep its runtime null check.
        var source = """
            package i2333directnil
            import System

            func G(x float64?) float64 {
                return x!!
            }

            Console.WriteLine(G(nil))
            """;

        var (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("InvalidOperationException", stderr);
    }

    [Fact]
    public void DirectBangBang_OnNonNarrowedNullableValueType_HasValue_ReturnsValue()
    {
        var source = """
            package i2333directvalue
            import System

            func G(x float64?) float64 {
                return x!!
            }

            Console.WriteLine(G(2.5))
            """;

        Assert.Equal("2.5\n", CompileAndRun(source));
    }

    [Fact]
    public void DirectBangBang_OnReferenceType_Nil_StillThrowsNullReferenceException()
    {
        // Preserves reference-type `!!` runtime null checks.
        var source = """
            package i2333refnil
            import System

            func F(s string?) int32 {
                return s!!.Length
            }

            Console.WriteLine(F(nil))
            """;

        var (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("NullReferenceException", stderr);
    }

    [Fact]
    public void DirectBangBang_OnReferenceType_NonNil_ReturnsValue()
    {
        var source = """
            package i2333refvalue
            import System

            func F(s string?) int32 {
                return s!!.Length
            }

            Console.WriteLine(F("abc"))
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void OahuArgParserShape_FindFloatArgNarrowedThenBangBang_Runs()
    {
        // Real Oahu occurrence from the issue: ArgParser.FindFloatArg
        // narrows a `double? arg` via a nil guard, then reads `arg!!`.
        var source = """
            package i2333argparser
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
            Console.WriteLine(FindFloatArg(0.0))
            """;

        Assert.Equal("0\n3.5\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void OahuLogTmpFileMaintenanceShape_DateTimeNarrowedArithmetic_Runs()
    {
        // Real Oahu occurrence from the issue: LogTmpFileMaintenance narrows
        // a `DateTime?` last-run timestamp via a nil guard, then reads
        // `last!!` inside a `DateTime` subtraction.
        var source = """
            package i2333logtmpfile
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
            Console.WriteLine(ShouldRun(baseline, baseline.AddHours(2.0)))
            """;

        Assert.Equal("True\nFalse\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void NestedNarrowedFloat_MultipleReadsAndArithmetic_Runs()
    {
        // Multiple narrowed reads plus arithmetic in the narrowed branch —
        // guards against a fix that only handles a single top-level `!!`.
        var source = """
            package i2333nestedarith
            import System

            func Sum(x float64?) float64 {
                if x == nil {
                    return 0.0
                } else {
                    return x!! + x!! * 2.0
                }
            }

            Console.WriteLine(Sum(nil))
            Console.WriteLine(Sum(3.0))
            """;

        Assert.Equal("0\n9\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool expectSuccess)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2333_narrowed_").FullName;
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

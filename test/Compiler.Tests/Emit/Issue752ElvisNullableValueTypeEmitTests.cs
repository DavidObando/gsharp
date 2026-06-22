// <copyright file="Issue752ElvisNullableValueTypeEmitTests.cs" company="GSharp">
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
/// Issue #752 / ADR-0084 L3: the null-coalescing (<c>??</c>) operator over a value-type
/// <c>Nullable&lt;T&gt;</c> receiver. Issue #519 introduced the HasValue-based
/// emit path; this file pins down the exact patterns enumerated in #752 and
/// guards against regression in the cheaper <c>GetValueOrDefault()</c> shape
/// used on the non-null branch (no boxing, no callvirt, no redundant
/// HasValue/throw — the BCL property's predicate was just observed).
///
/// Each test compiles via <c>gsc</c>, runs <c>ilverify</c> against the
/// produced PE, then executes the assembly under <c>dotnet exec</c> and
/// asserts on the captured stdout. Invalid IL is surfaced as a verification
/// failure rather than silently passing.
/// </summary>
public class Issue752ElvisNullableValueTypeEmitTests
{
    [Fact]
    public void Elvis_NullableInt_LeftNil_ReturnsRightUnderlying()
    {
        // Canonical absent case: result type is the underlying `int32`.
        // Non-null branch reaches `GetValueOrDefault()` against the spill
        // slot; null branch evaluates the literal RHS.
        var source = """
            package P

            import System

            let v int32? = nil
            let n = v ?? 0
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void Elvis_NullableInt_LeftPresent_ReturnsLeftUnderlying()
    {
        // Mirror of the absent case: HasValue is true, so the non-null
        // branch fires and `GetValueOrDefault()` returns 42 without the
        // BCL `get_Value` throw path.
        var source = """
            package P

            import System

            let v int32? = 42
            let n = v ?? 0
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Elvis_NullableInt_Nested_BothNullableOperands_ChainsThroughRightArm()
    {
        // `(a ?? b) ?? 0` — both inner operands are `int32?`. The inner
        // expression's result is `int32?` (preserving wrapper shape per
        // existing typing rules), and the outer's result is `int32`.
        // Two separate spill slots are pre-allocated, one per BoundBinary.
        var source = """
            package P

            import System

            let a int32? = nil
            let b int32? = 7
            let n = (a ?? b) ?? 0
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void Elvis_NullableInt_Nested_AllNil_FallsThroughToLiteral()
    {
        // Same shape as above but every nullable arm is absent; the final
        // non-nullable literal must win.
        var source = """
            package P

            import System

            let a int32? = nil
            let b int32? = nil
            let n = (a ?? b) ?? 0
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void Elvis_ReferenceTypeString_RegressionGuard()
    {
        // Reference-typed nullables must continue to flow through the
        // existing `dup; brtrue; pop; rhs` short-circuit, which is legal
        // IL for object references. The value-type HasValue branch must
        // not capture this case (regression guard for the #752 fix).
        var source = """
            package P

            import System

            let s string? = nil
            let r string = s ?? "missing"
            Console.WriteLine(r)

            let t string? = "hello"
            let u string = t ?? "missing"
            Console.WriteLine(u)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("missing\nhello\n", output);
    }

    [Fact]
    public void Elvis_NullableInt_LeftNil_BothArmsNullable_PreservesAbsenceShape()
    {
        // When both arms are `int32?`, the operator result type is the
        // wrapper. The HasValue==false path returns the RHS wrapper
        // unchanged; observed through `!!` here to assert the inner
        // value once the operator picked the RHS.
        var source = """
            package P

            import System

            let a int32? = nil
            let b int32? = 99
            let r int32? = a ?? b
            Console.WriteLine(r!!)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("99\n", output);
    }

    [Fact]
    public void Elvis_NullableInt_ReceiverOfInstanceCall_TakesAddressOfUnderlyingResult()
    {
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
        var source = """
            package P

            import System

            let v int32? = 42
            Console.WriteLine((v ?? -1).ToString())

            let w int32? = nil
            Console.WriteLine((w ?? -1).ToString())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n-1\n", output);
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue752_").FullName;
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

// <copyright file="Issue1833EnumConstraintViolationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1833 (follow-up review note on PR #1832 / #1601): a value-type-erased
/// type argument that is <c>struct</c>-constrained but <b>not</b>
/// <c>Enum</c>-constrained — a concrete non-enum user struct, or a bare
/// <c>[T struct]</c> type parameter — passed to a BCL generic method whose
/// type parameter carries a real <c>System.Enum</c> base-class constraint
/// (<c>Enum.IsDefined&lt;TEnum&gt;</c>) must be rejected by the compiler with a
/// clear <c>GS0152</c> constraint-violation diagnostic at bind time. Before the
/// fix, <c>OverloadResolution.SatisfiesGenericConstraints</c> unconditionally
/// treated any <c>System.Enum</c>-named base constraint as satisfied once the
/// argument was classified as a value-type-erased symbol, so the candidate
/// bound through overload resolution and only failed later — at CLR
/// verification/emit, or as a runtime crash — instead of failing cleanly here
/// at <c>gsc</c> compile time.
/// <para>
/// This is an end-to-end compiler-driver test (mirrors
/// <c>Issue1601GenericEnumTryParseForwardEmitTests.CompileAndRun</c>): it
/// invokes <see cref="Program.Main(string[])"/> exactly as the <c>gsc</c> CLI
/// does and asserts the process reports a non-zero exit with the GS0152
/// diagnostic — never a PE emitted at all, and never an unhandled exception
/// (which would surface as a non-graceful crash instead of a diagnostic).
/// </para>
/// </summary>
public class Issue1833EnumConstraintViolationEmitTests
{
    [Fact]
    public void ConcreteNonEnumStruct_EnumIsDefined_FailsCompileWithConstraintDiagnostic_NotCrash()
    {
        const string source = """
            package Probe
            import System

            struct Point1833A {
                var X int32
                var Y int32
            }

            var pt = Point1833A(1, 2)
            var ok = Enum.IsDefined[Point1833A](pt)
            """;

        var (exitCode, stdout, stderr) = Compile(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0152", stdout + stderr);
        Assert.DoesNotContain("GS9999", stdout + stderr);
        Assert.DoesNotContain("Unhandled exception", stdout + stderr);
    }

    [Fact]
    public void StructOnlyTypeParameter_ForwardedToEnumIsDefined_FailsCompileWithConstraintDiagnostic()
    {
        const string source = """
            package Probe
            import System

            func Check1833B[T struct](v T) bool {
                return Enum.IsDefined[T](v)
            }
            """;

        var (exitCode, stdout, stderr) = Compile(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0152", stdout + stderr);
        Assert.DoesNotContain("GS9999", stdout + stderr);
        Assert.DoesNotContain("Unhandled exception", stdout + stderr);
    }

    private static (int ExitCode, string Stdout, string Stderr) Compile(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1833_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
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

            return (compileExit, compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}

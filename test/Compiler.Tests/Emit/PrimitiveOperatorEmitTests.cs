// <copyright file="PrimitiveOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4 of #142: end-to-end operator coverage for the expanded
/// numeric primitive set. Each test compiles a tiny GSharp program
/// that exercises one operator on one new primitive type, runs it,
/// and asserts the printed value matches what the BCL produces for
/// the same expression in C#.
/// </summary>
public class PrimitiveOperatorEmitTests
{
    [Theory]
    [InlineData("int64", "100L + 50L", "150")]
    [InlineData("int64", "100L - 50L", "50")]
    [InlineData("int64", "100L * 50L", "5000")]
    [InlineData("int64", "100L / 50L", "2")]
    [InlineData("int64", "100L % 30L", "10")]
    [InlineData("int64", "100L < 50L", "False")]
    [InlineData("int64", "100L >= 100L", "True")]
    [InlineData("int64", "100L == 100L", "True")]
    [InlineData("int64", "100L & 6L", "4")]
    [InlineData("int64", "100L | 6L", "102")]
    [InlineData("int64", "100L ^ 6L", "98")]
    [InlineData("int64", "1L << 10", "1024")]
    [InlineData("int64", "1024L >> 2", "256")]

    // Issue #421 (P2-2): Go semantics — count >= width yields 0 (not CLR's masked shift).
    [InlineData("int32", "1 << 33", "0")]
    [InlineData("int32", "1 << 32", "0")]
    [InlineData("int32", "100 >> 32", "0")]
    [InlineData("uint32", "uint32(1) << 32", "0")]
    [InlineData("uint32", "uint32(100) >> 64", "0")]
    [InlineData("int64", "1L << 64", "0")]
    [InlineData("int64", "1L << 100", "0")]
    [InlineData("int64", "1024L >> 64", "0")]
    [InlineData("uint64", "uint64(1) << 64", "0")]
    [InlineData("uint64", "uint64(1024) >> 64", "0")]

    // Boundary: shift by exactly width-1 still works normally.
    [InlineData("int32", "1 << 31", "-2147483648")]
    [InlineData("int64", "1L << 63", "-9223372036854775808")]
    [InlineData("uint32", "uint32(1) << 31", "2147483648")]
    [InlineData("uint64", "uint64(1) << 63", "9223372036854775808")]

    // Shift by 0 is identity.
    [InlineData("int32", "42 << 0", "42")]
    [InlineData("int64", "42L >> 0", "42")]
    public void Long_Operators_ProduceExpectedValue(string _, string expr, string expected)
    {
        Assert.Equal(expected + "\n", CompileAndRun(BuildSource(expr)));
    }

    [Theory]
    [InlineData("uint64", "9000000000UL + 1000000000UL", "10000000000")]
    [InlineData("uint64", "9000000000UL / 3UL", "3000000000")]
    [InlineData("uint64", "9000000000UL > 1UL", "True")]
    public void ULong_Operators_UseUnsignedOpcodes(string _, string expr, string expected)
    {
        Assert.Equal(expected + "\n", CompileAndRun(BuildSource(expr)));
    }

    [Theory]
    [InlineData("float64", "1.5 + 2.25", "3.75")]
    [InlineData("float64", "10.0 / 4.0", "2.5")]
    [InlineData("float64", "1.5 < 2.0", "True")]
    public void Float64_Operators_ProduceExpectedValue(string _, string expr, string expected)
    {
        Assert.Equal(expected + "\n", CompileAndRun(BuildSource(expr)));
    }

    [Theory]
    [InlineData("decimal", "1.5M + 2.25M", "3.75")]
    [InlineData("decimal", "10M / 4M", "2.5")]
    [InlineData("decimal", "5M * 7M", "35")]
    [InlineData("decimal", "10M - 3M", "7")]
    [InlineData("decimal", "10M % 3M", "1")]
    [InlineData("decimal", "1.5M < 2M", "True")]
    [InlineData("decimal", "2M == 2M", "True")]
    [InlineData("decimal", "2M != 3M", "True")]
    public void Decimal_Operators_RouteThroughOperatorMethods(string _, string expr, string expected)
    {
        Assert.Equal(expected + "\n", CompileAndRun(BuildSource(expr)));
    }

    [Fact]
    public void Char_Equality_Works()
    {
        var src = """
            package P
            import System

            let a = 'A'
            let b = 'A'
            Console.WriteLine(a == b)
            """;
        Assert.Equal("True\n", CompileAndRun(src));
    }

    [Fact]
    public void Object_ReferenceEquality_OnSameInstance_IsTrue()
    {
        var src = """
            package P
            import System

            let s = "hello"
            let a object = s
            let b object = s
            Console.WriteLine(a == b)
            """;
        Assert.Equal("True\n", CompileAndRun(src));
    }

    [Fact]
    public void Decimal_UnaryNegation_RoutesThroughOperatorMethod()
    {
        var src = """
            package P
            import System

            let x = 3.14M
            Console.WriteLine(-x)
            """;
        Assert.Equal("-3.14\n", CompileAndRun(src));
    }

    [Fact]
    public void Long_UnaryNegation_UsesNegOpcode()
    {
        var src = """
            package P
            import System

            let x = 42L
            Console.WriteLine(-x)
            """;
        Assert.Equal("-42\n", CompileAndRun(src));
    }

    [Fact]
    public void Byte_OnesComplement_Works()
    {
        // ~1 as byte is 0xFE = 254. We compare against another byte value
        // to keep the result type as byte, since Console.WriteLine overload
        // selection for byte (no exact overload exists in System.Console)
        // is part of Phase 5 work.
        var src = """
            package P
            import System

            let x = uint8(1)
            let y = uint8(254)
            Console.WriteLine(^x == y)
            """;
        Assert.Equal("True\n", CompileAndRun(src));
    }

    private static string BuildSource(string expr)
    {
        return $$"""
            package P
            import System

            Console.WriteLine({{expr}})
            """;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_phase4_ops_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
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

            using var proc = Process.Start(psi);
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

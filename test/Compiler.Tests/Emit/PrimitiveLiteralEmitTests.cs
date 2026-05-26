// <copyright file="PrimitiveLiteralEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 3 of #142: end-to-end emit-and-execute coverage for ADR-0044's
/// expanded primitive set. Each test compiles a tiny GSharp program that
/// stresses a literal value, an implicit widening, or an explicit
/// narrowing of one of the new primitive types and asserts that the
/// printed output matches the BCL's stringification of the same value.
/// </summary>
public class PrimitiveLiteralEmitTests
{
    [Fact]
    public void LongLiteral_Suffixed_RoundTripsThroughWriteLine()
    {
        var source = """
            package P
            import System

            let x = 9999999999L
            Console.WriteLine(x)
            """;

        Assert.Equal("9999999999\n", CompileAndRun(source));
    }

    [Fact]
    public void Float32Literal_Suffixed_RoundTrips()
    {
        var source = """
            package P
            import System

            let x = 3.5F
            Console.WriteLine(x)
            """;

        Assert.Equal("3.5\n", CompileAndRun(source));
    }

    [Fact]
    public void Float64Literal_Default_RoundTrips()
    {
        var source = """
            package P
            import System

            let x = 2.5
            Console.WriteLine(x)
            """;

        Assert.Equal("2.5\n", CompileAndRun(source));
    }

    [Fact]
    public void DecimalLiteral_SmallValue_UsesIntCtor()
    {
        var source = """
            package P
            import System

            let x = 42M
            Console.WriteLine(x)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void DecimalLiteral_FractionalValue_UsesFiveArgCtor()
    {
        var source = """
            package P
            import System

            let x = 3.14M
            Console.WriteLine(x)
            """;

        Assert.Equal("3.14\n", CompileAndRun(source));
    }

    [Fact]
    public void DecimalLiteral_Zero_UsesStaticField()
    {
        var source = """
            package P
            import System

            let x = 0M
            Console.WriteLine(x)
            """;

        Assert.Equal("0\n", CompileAndRun(source));
    }

    [Fact]
    public void UnsuffixedInt_WidensImplicitlyTo_LongTarget()
    {
        // ADR-0044: `let x : long = 1` works without `1L`.
        var source = """
            package P
            import System

            let x long = 1
            Console.WriteLine(x)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void ExplicitNarrowing_LongToInt_Truncates()
    {
        var source = """
            package P
            import System

            let big = 4294967297L
            let n = int(big)
            Console.WriteLine(n)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void ExplicitNarrowing_Float64ToInt_Truncates()
    {
        var source = """
            package P
            import System

            let f = 3.9
            let n = int(f)
            Console.WriteLine(n)
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void Int_To_Object_Boxes_ForObjectParameter()
    {
        var source = """
            package P
            import System

            let n = 42
            Console.WriteLine(n)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void CharLiteral_Prints_AsChar()
    {
        var source = """
            package P
            import System

            let c = 'A'
            Console.WriteLine(c)
            """;

        Assert.Equal("A\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_phase3_emit_").FullName;
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

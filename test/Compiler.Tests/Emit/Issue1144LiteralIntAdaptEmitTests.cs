// <copyright file="Issue1144LiteralIntAdaptEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1144: end-to-end emit + execution tests proving a constant integer
/// literal operand of a binary operator adapts to the OTHER operand's integer
/// type and is emitted with that type. Each program compiles via <c>gsc</c>,
/// is IL-verified, and runs under <c>dotnet exec</c> with its runtime values
/// asserted — including an unsigned-arithmetic check to confirm the literal is
/// emitted as the unsigned operand type (not int32).
/// </summary>
public class Issue1144LiteralIntAdaptEmitTests
{
    [Fact]
    public void UInt32Increment_LiteralAdapts_AndRuns()
    {
        var source = """
            package main
            import System

            func F(a uint32) uint32 { return a + 1 }

            func run() {
                Console.WriteLine(F(uint32(10)))
            }

            run()
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    [Fact]
    public void UInt8BitwiseOr_LiteralAdapts_AndRuns()
    {
        var source = """
            package main
            import System

            func G(b uint8) int32 { return int32(b | 4) }

            func run() {
                Console.WriteLine(G(uint8(1)))
            }

            run()
            """;

        // 1 | 4 == 5
        Assert.Equal("5\n", CompileAndRun(source));
    }

    [Fact]
    public void UInt8Equality_LiteralAdapts_AndRuns()
    {
        var source = """
            package main
            import System

            func H(c uint8) bool { return c == 0 }

            func run() {
                Console.WriteLine(H(uint8(0)))
                Console.WriteLine(H(uint8(5)))
            }

            run()
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void UInt32Wrap_LiteralEmittedAsUnsigned_NotInt32()
    {
        // If the literal `1` were emitted as int32 and the addition performed
        // as signed int32, `0xFFFFFFFF + 1` would overflow into a negative
        // int32. Adapting the literal to uint32 makes this wrap to 0 as
        // unsigned arithmetic — proving the emitted operand type.
        var source = """
            package main
            import System

            func F(a uint32) uint32 { return a + 1 }

            func run() {
                var max = 4294967295U
                Console.WriteLine(F(max))
            }

            run()
            """;

        Assert.Equal("0\n", CompileAndRun(source));
    }

    [Fact]
    public void Int64Operand_LiteralAdapts_AndRuns()
    {
        var source = """
            package main
            import System

            func F(l int64) int64 { return l + 1 }

            func run() {
                Console.WriteLine(F(9223372036854775806L))
            }

            run()
            """;

        Assert.Equal("9223372036854775807\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1144_").FullName;
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

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath, null, Array.Empty<string>());

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

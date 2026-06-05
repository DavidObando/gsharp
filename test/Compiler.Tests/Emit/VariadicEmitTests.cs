// <copyright file="VariadicEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4.8 emit-parity regression tests for user-defined variadic
/// functions. Variadic packing is performed by the binder
/// (Binder.BindCallExpression wraps trailing args in a
/// <c>BoundArrayCreationExpression</c> of the slice element type) before the
/// expression reaches the emitter, so the emit path is exercised entirely
/// through pre-existing nodes; these tests guard against regressions in
/// either side. BCL params calls (e.g. <c>Console.WriteLine(string, params
/// object[])</c>) are tracked separately; the binder's overload resolution
/// does not expand params overloads today.
/// </summary>
public class VariadicEmitTests
{
    [Fact]
    public void VariadicSum_MultipleArgs()
    {
        var source = """
            package P
            import System

            func sum(nums ...int32) int32 {
              var total = 0
              for v := range nums {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sum(1, 2, 3, 4, 5))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void VariadicSum_ZeroAndOneArg()
    {
        var source = """
            package P
            import System

            func sum(nums ...int32) int32 {
              var total = 0
              for v := range nums {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sum())
            Console.WriteLine(sum(42))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n42\n", output);
    }

    [Fact]
    public void VariadicWithFixedPrefix()
    {
        var source = """
            package P
            import System

            func sumWithBase(base int32, extras ...int32) int32 {
              var total = base
              for v := range extras {
                total = total + v
              }
              return total
            }

            Console.WriteLine(sumWithBase(100, 1, 2, 3))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("106\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_variadic_emit_").FullName;
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

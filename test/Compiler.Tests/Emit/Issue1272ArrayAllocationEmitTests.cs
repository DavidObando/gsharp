// <copyright file="Issue1272ArrayAllocationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1272: end-to-end emit+run coverage for the native runtime/zero-init
/// array allocation form <c>[n]T</c>. The emitter lowers it to a CIL
/// <c>newarr</c>, which zero-initialises every element, yielding a <c>[]T</c>
/// slice of length <c>n</c>. These tests prove the produced slice has the
/// requested length, every element is the zero value, and that mutating and
/// reading the elements works.
/// </summary>
public class Issue1272ArrayAllocationEmitTests
{
    [Fact]
    public void RuntimeLength_ProducesZeroInitialisedSlice()
    {
        var source = """
            package P
            import System

            func make(n int32) []int32 {
                return [n]int32
            }

            let a = make(4)
            Console.WriteLine(a.Length)
            Console.WriteLine(a[0])
            Console.WriteLine(a[1])
            Console.WriteLine(a[2])
            Console.WriteLine(a[3])
            """;

        Assert.Equal("4\n0\n0\n0\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void ConstantLength_ProducesZeroInitialisedSlice()
    {
        var source = """
            package P
            import System

            let a = [3]int32
            Console.WriteLine(a.Length)
            Console.WriteLine(a[0] + a[1] + a[2])
            """;

        Assert.Equal("3\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void RuntimeLength_MutateAndRead()
    {
        var source = """
            package P
            import System

            let n = 5
            var a = [n]int32
            a[0] = 10
            a[4] = 20
            Console.WriteLine(a.Length)
            Console.WriteLine(a[0])
            Console.WriteLine(a[4])
            Console.WriteLine(a[2])
            """;

        Assert.Equal("5\n10\n20\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void EmptyInitializerSpelling_ProducesZeroInitialisedSlice()
    {
        var source = """
            package P
            import System

            let n = 2
            let a = [n]int32{}
            Console.WriteLine(a.Length)
            Console.WriteLine(a[0] + a[1])
            """;

        Assert.Equal("2\n0\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1272_emit_").FullName;
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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}

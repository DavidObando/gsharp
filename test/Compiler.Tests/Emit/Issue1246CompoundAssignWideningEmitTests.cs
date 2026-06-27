// <copyright file="Issue1246CompoundAssignWideningEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1246: end-to-end execution of compound assignments whose right
/// operand widens into the LHS integer type (<c>int32 += uint8</c>,
/// <c>int64 += int32</c>, …). Before the fix these were rejected with GS0129
/// during binding; now the widening conversion is emitted before the operation
/// and the result is stored back into the LHS, producing the correct runtime
/// value — exactly like the equivalent <c>a = a + b</c>.
/// </summary>
public class Issue1246CompoundAssignWideningEmitTests
{
    [Fact]
    public void Int32PlusEqualsUInt8_StoresWidenedSum()
    {
        var source = """
            package P
            import System

            var a int32 = 200
            var b uint8 = 100
            a += b
            Console.WriteLine(a)
            """;

        Assert.Equal("300\n", CompileAndRun(source));
    }

    [Fact]
    public void Int64AccumulatesInt32InLoop_StoresWidenedTotal()
    {
        var source = """
            package P
            import System

            var acc int64 = 0
            var i int32 = 1
            while i <= 5 {
                acc += i
                i = i + 1
            }
            Console.WriteLine(acc)
            """;

        Assert.Equal("15\n", CompileAndRun(source));
    }

    [Fact]
    public void Int64TimesEqualsInt32_StoresWidenedProduct()
    {
        var source = """
            package P
            import System

            var a int64 = 100000
            var b int32 = 100000
            a *= b
            Console.WriteLine(a)
            """;

        Assert.Equal("10000000000\n", CompileAndRun(source));
    }

    [Fact]
    public void Int64PlusEqualsIntLiteral_StoresSum()
    {
        var source = """
            package P
            import System

            var x int64 = 2000000000
            x += 2000000000
            Console.WriteLine(x)
            """;

        Assert.Equal("4000000000\n", CompileAndRun(source));
    }

    [Fact]
    public void Int32MinusEqualsUInt8_StoresWidenedDifference()
    {
        var source = """
            package P
            import System

            var a int32 = 500
            var b uint8 = 200
            a -= b
            Console.WriteLine(a)
            """;

        Assert.Equal("300\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1246_").FullName;
        try
        {
            return CompileAndRunImpl(source, tempDir);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunImpl(string source, string tempDir)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
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

        using var proc = Process.Start(psi);
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

        return stdout.Replace("\r\n", "\n");
    }
}

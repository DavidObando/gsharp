// <copyright file="Issue1226UnsignedElementIncrementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1226: <c>++</c>/<c>--</c> (and <c>+=</c>/<c>-=</c> with an untyped
/// integer literal) on an array-element / indexer lvalue whose element type is
/// a non-<c>int32</c> integer (<c>uint8</c>, <c>uint16</c>, …) was rejected with
/// GS0129 because the synthetic increment constant <c>1</c> defaulted to
/// <c>int32</c> instead of the element type. The same operation already worked
/// for plain locals, fields, and <c>int32</c> array elements. The binder now
/// adapts the constant integer literal to the element type for the
/// element-access write-through path (mirroring the #1144 literal adaptation
/// performed by the local/field path). These tests compile and run real
/// programs end-to-end, asserting the in-place mutation of the element bytes.
/// </summary>
public class Issue1226UnsignedElementIncrementEmitTests
{
    [Fact]
    public void Uint8Element_Increment_StoresIncrementedByte()
    {
        var source = """
            package P
            import System

            var data = []uint8{10, 20, 30, 40}
            data[1]++
            Console.WriteLine(int32(data[1]))
            """;

        Assert.Equal("21\n", CompileAndRun(source));
    }

    [Fact]
    public void Uint8Element_Decrement_StoresDecrementedByte()
    {
        var source = """
            package P
            import System

            var data = []uint8{10, 20, 30, 40}
            data[2]--
            Console.WriteLine(int32(data[2]))
            """;

        Assert.Equal("29\n", CompileAndRun(source));
    }

    [Fact]
    public void Uint8Element_PlusEqualsLiteral_StoresSum()
    {
        var source = """
            package P
            import System

            var data = []uint8{10, 20, 30, 40}
            data[0] += 1
            Console.WriteLine(int32(data[0]))
            """;

        Assert.Equal("11\n", CompileAndRun(source));
    }

    [Fact]
    public void Uint8Element_MinusEqualsLiteral_StoresDifference()
    {
        var source = """
            package P
            import System

            var data = []uint8{10, 20, 30, 40}
            data[3] -= 1
            Console.WriteLine(int32(data[3]))
            """;

        Assert.Equal("39\n", CompileAndRun(source));
    }

    [Fact]
    public void Uint16Element_Increment_StoresIncrementedValue()
    {
        var source = """
            package P
            import System

            var data = []uint16{1000, 2000}
            data[0]++
            Console.WriteLine(int32(data[0]))
            """;

        Assert.Equal("1001\n", CompileAndRun(source));
    }

    [Fact]
    public void Uint32Element_Increment_StoresIncrementedValue()
    {
        var source = """
            package P
            import System

            var data = []uint32{100000, 200000}
            data[1]++
            Console.WriteLine(int32(data[1]))
            """;

        Assert.Equal("200001\n", CompileAndRun(source));
    }

    [Fact]
    public void Int16Element_Increment_StoresIncrementedValue()
    {
        var source = """
            package P
            import System

            var data = []int16{-5, 7}
            data[0]++
            Console.WriteLine(int32(data[0]))
            """;

        Assert.Equal("-4\n", CompileAndRun(source));
    }

    [Fact]
    public void Uint8Element_BigEndianCounterIncrement_CarriesAcrossBytes()
    {
        // AES-CTR-style big-endian 128-bit counter increment: increment the
        // least-significant byte, carrying into more-significant bytes while the
        // current byte wraps to 0. Exercises `[]uint8` element `++` in a loop
        // with the wrap-around (overflow) behaviour of the unsigned element.
        var source = """
            package P
            import System

            func Increment(counter []uint8) {
                var i = 15
                for i >= 0 {
                    counter[i]++
                    if counter[i] != uint8(0) {
                        return
                    }
                    i--
                }
            }

            var counter = []uint8{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255}
            Increment(counter)
            Console.WriteLine(int32(counter[15]))
            Console.WriteLine(int32(counter[14]))

            var wrap = []uint8{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255}
            Increment(wrap)
            Console.WriteLine(int32(wrap[15]))
            Console.WriteLine(int32(wrap[14]))
            Console.WriteLine(int32(wrap[13]))
            """;

        // First counter: last byte 255 -> 0 with carry into byte 14 (0 -> 1).
        // Second counter: bytes 14,15 both 255 -> both 0, carry into byte 13.
        Assert.Equal("0\n1\n0\n0\n1\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1226_").FullName;
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

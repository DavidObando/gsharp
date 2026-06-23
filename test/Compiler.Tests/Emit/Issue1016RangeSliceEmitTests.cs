// <copyright file="Issue1016RangeSliceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1016: the range/slice operator <c>..</c> slices arrays, slices,
/// strings, and span-like values inside an indexer (<c>a[lo..hi]</c>, with the
/// open forms <c>a[..hi]</c>, <c>a[lo..]</c>, <c>a[..]</c>). These tests
/// compile and run emitted programs and assert the printed results, exercising
/// the BCL mappings:
/// <list type="bullet">
/// <item><description>arrays/slices -> <c>new T[len]</c> + <c>Array.Copy</c>.</description></item>
/// <item><description><c>string</c> -> <c>Substring(start, len)</c>.</description></item>
/// <item><description>span-like types with <c>Count</c> + <c>Slice(int, int)</c>
/// (e.g. <c>ArraySegment</c>).</description></item>
/// </list>
/// </summary>
public class Issue1016RangeSliceEmitTests
{
    [Fact]
    public void IntArray_ClosedRange()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[1..3]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n20\n30\n", CompileAndRun(source));
    }

    [Fact]
    public void IntArray_OpenLowerBound()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[..2]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n10\n20\n", CompileAndRun(source));
    }

    [Fact]
    public void IntArray_OpenUpperBound()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[3..]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n40\n50\n", CompileAndRun(source));
    }

    [Fact]
    public void IntArray_FullRange_CopiesAll()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[..]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[4])
            """;

        Assert.Equal("5\n10\n50\n", CompileAndRun(source));
    }

    [Fact]
    public void IntArray_Slice_IsACopy_NotAnAlias()
    {
        // Mutating the original array after slicing must not change the slice,
        // proving GetSubArray semantics (a fresh backing array).
        var source = """
            package P
            import System

            var a = []int32{1, 2, 3, 4}
            let b = a[0..2]
            a[0] = 99
            Console.WriteLine(b[0])
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void String_ClosedRange()
    {
        var source = """
            package P
            import System

            let s = "hello world"
            Console.WriteLine(s[0..5])
            """;

        Assert.Equal("hello\n", CompileAndRun(source));
    }

    [Fact]
    public void String_OpenBounds()
    {
        var source = """
            package P
            import System

            let s = "hello world"
            Console.WriteLine(s[6..])
            Console.WriteLine(s[..5])
            Console.WriteLine(s[..])
            """;

        Assert.Equal("world\nhello\nhello world\n", CompileAndRun(source));
    }

    [Fact]
    public void UserStructArray_SlicePreservesElements()
    {
        // Slicing an array of a user-defined struct exercises the `newarr`
        // element-type token path for a same-compilation TypeDef.
        var source = """
            package P
            import System

            struct Point {
                var X int32
                var Y int32
            }

            let pts = []Point{Point{X: 1, Y: 2}, Point{X: 3, Y: 4}, Point{X: 5, Y: 6}}
            let sl = pts[1..3]
            Console.WriteLine(sl[0].X)
            Console.WriteLine(sl[1].X)
            """;

        Assert.Equal("3\n5\n", CompileAndRun(source));
    }

    [Fact]
    public void ArraySegment_SpanLikeSlicePath()
    {
        // ArraySegment[T] has `int Count` + `Slice(int, int)`, exercising the
        // span-like slicing path (no Array.Copy).
        var source = """
            package P
            import System

            let arr = []int32{10, 20, 30, 40, 50}
            let seg = ArraySegment[int32](arr)
            let sub = seg[1..4]
            Console.WriteLine(sub.Count)
            Console.WriteLine(sub[0])
            Console.WriteLine(sub[2])
            """;

        Assert.Equal("3\n20\n40\n", CompileAndRun(source));
    }

    [Fact]
    public void Slice_ComputedBoundsFromExpressions()
    {
        // Bounds are arbitrary int expressions, not just literals.
        var source = """
            package P
            import System

            let a = []int32{0, 1, 2, 3, 4, 5, 6, 7}
            let lo = 2
            let hi = 6
            let b = a[lo..hi]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[3])
            """;

        Assert.Equal("4\n2\n5\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1016_emit_").FullName;
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

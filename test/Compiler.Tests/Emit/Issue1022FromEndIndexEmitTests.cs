// <copyright file="Issue1022FromEndIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1022: the from-end index marker <c>^n</c> indexes/slices from the end
/// of an array, slice, string, or span-like value. These tests compile and run
/// emitted programs and assert the printed results, covering:
/// <list type="bullet">
/// <item><description>a bare <c>a[^n]</c> single-element read (<c>length - n</c>).</description></item>
/// <item><description>from-end bounds in ranges (<c>a[1..^1]</c>, <c>a[..^3]</c>, <c>a[^2..]</c>).</description></item>
/// <item><description>arrays/slices, strings, and span-like (<c>ArraySegment</c>) targets.</description></item>
/// <item><description>regression: one's-complement and XOR <c>^</c> are unchanged.</description></item>
/// </list>
/// </summary>
public class Issue1022FromEndIndexEmitTests
{
    [Fact]
    public void IntArray_SingleFromEndIndex()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            Console.WriteLine(a[^1])
            Console.WriteLine(a[^2])
            Console.WriteLine(a[^5])
            """;

        Assert.Equal("50\n40\n10\n", CompileAndRun(source));
    }

    [Fact]
    public void IntArray_FromEndUpperBound_DropsLast()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[1..^1]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[2])
            """;

        Assert.Equal("3\n20\n40\n", CompileAndRun(source));
    }

    [Fact]
    public void IntArray_FromEndUpperBound_OpenLower()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[..^3]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n10\n20\n", CompileAndRun(source));
    }

    [Fact]
    public void IntArray_FromEndLowerBound_OpenUpper()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[^2..]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n40\n50\n", CompileAndRun(source));
    }

    [Fact]
    public void IntArray_FromEndBothBounds()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[^4..^1]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[2])
            """;

        Assert.Equal("3\n20\n40\n", CompileAndRun(source));
    }

    [Fact]
    public void String_FromEndForms()
    {
        var source = """
            package P
            import System

            let s = "abcdef"
            Console.WriteLine(s[..^3])
            Console.WriteLine(s[1..^1])
            Console.WriteLine(s[^2..])
            """;

        Assert.Equal("abc\nbcde\nef\n", CompileAndRun(source));
    }

    [Fact]
    public void ArraySegment_SpanLikeFromEndSlice()
    {
        // ArraySegment[T] has `int Count`; from-end bounds compute against it.
        var source = """
            package P
            import System

            let arr = []int32{10, 20, 30, 40, 50}
            let seg = ArraySegment[int32](arr)
            let sub = seg[1..^1]
            Console.WriteLine(sub.Count)
            Console.WriteLine(sub[0])
            Console.WriteLine(sub[2])
            """;

        Assert.Equal("3\n20\n40\n", CompileAndRun(source));
    }

    [Fact]
    public void OnesComplementAndXor_Unchanged()
    {
        // Regression: prefix `^` (one's-complement) and infix `^` (XOR) keep
        // their existing meanings outside the leading index-bound position.
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            Console.WriteLine(^0)
            Console.WriteLine(6 ^ 3)
            Console.WriteLine(a[1 ^ 2])
            """;

        Assert.Equal("-1\n5\n40\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1022_emit_").FullName;
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

// <copyright file="Issue1038StandaloneRangeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1038: emit/execution coverage for the standalone range value
/// (<c>let r = 1..3</c>) and its use as an index argument (<c>a[r]</c>). These
/// tests compile and run emitted programs (with ilverify) and assert the printed
/// results across arrays, <c>[]T</c> slices, strings, and span-like values, plus
/// the from-end upper bound and the four open forms.
/// </summary>
public class Issue1038StandaloneRangeEmitTests
{
    [Fact]
    public void RangeValue_SlicesArray_ClosedRange()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let r = 1..3
            let b = a[r]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n20\n30\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_SlicesArray_OpenLowerBound()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let r = ..2
            let b = a[r]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n10\n20\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_SlicesArray_OpenUpperBound()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let r = 3..
            let b = a[r]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n40\n50\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_SlicesArray_FullRange()
    {
        var source = """
            package P
            import System

            let a = []int32{1, 2, 3, 4}
            let r = ..
            let b = a[r]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[3])
            """;

        Assert.Equal("4\n1\n4\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_FromEndUpperBound_SlicesArray()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let r = 1..^1
            let b = a[r]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[2])
            """;

        Assert.Equal("3\n20\n40\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_OpenLowerWithFromEndUpper_SlicesArray()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let r = ..^2
            let b = a[r]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[2])
            """;

        Assert.Equal("3\n10\n30\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_SlicesString()
    {
        var source = """
            package P
            import System

            let s = "hello world"
            let r = 6..
            Console.WriteLine(s[r])
            """;

        Assert.Equal("world\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_AdditivePrecedence()
    {
        // 1+1..2+2 == 2..4 -> {30, 40}.
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let r = 1+1..2+2
            let b = a[r]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            Console.WriteLine(b[1])
            """;

        Assert.Equal("2\n30\n40\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_InlineParenthesized()
    {
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let b = a[(1..3)]
            Console.WriteLine(b.Length)
            Console.WriteLine(b[0])
            """;

        Assert.Equal("2\n20\n", CompileAndRun(source));
    }

    [Fact]
    public void RangeValue_SlicesSpanLike_ArraySegment()
    {
        // ArraySegment<int> exposes Count + Slice(int, int): the span-like path.
        var source = """
            package P
            import System

            let a = []int32{10, 20, 30, 40, 50}
            let seg = ArraySegment[int32](a)
            let r = 1..4
            let s = seg[r]
            Console.WriteLine(s.Count)
            Console.WriteLine(s[0])
            Console.WriteLine(s[2])
            """;

        Assert.Equal("3\n20\n40\n", CompileAndRun(source));
    }

    [Fact]
    public void LeadingFromEndMarker_ReportsGs0410()
    {
        var source = """
            package P
            import System

            let r = ^1..3
            Console.WriteLine(0)
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0410", diagnostics);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1038_emit_").FullName;
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

    private static string CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1038_neg_").FullName;
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
            try
            {
                var compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
                Assert.NotEqual(0, compileExit);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return compileOut.ToString() + compileErr.ToString();
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

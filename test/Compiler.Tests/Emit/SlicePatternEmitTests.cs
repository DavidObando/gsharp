// <copyright file="SlicePatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1505: slice ("rest") subpatterns in list patterns. These tests
/// exercise the emitter end-to-end (compile → ilverify → run) for every
/// supported slice form and assert runtime behavior + captured slice contents.
/// Each test uses unique package/type/func names because the FunctionTypeSymbol
/// cache is not cleared between in-process tests.
/// </summary>
public class SlicePatternEmitTests
{
    [Fact]
    public void SlicePattern_Bookend_MatchesRegardlessOfMiddleLength()
    {
        var gsource = """
            package Slice.Bookend
            import System

            func classify(xs []int32) {
                switch xs {
                    case [1, .., 3] { Console.WriteLine("bookend") }
                    default { Console.WriteLine("other") }
                }
            }

            classify([]int32{1, 3})
            classify([]int32{1, 2, 3})
            classify([]int32{1, 9, 9, 9, 3})
            classify([]int32{2, 3})
            classify([]int32{1, 2})
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("bookend\nbookend\nbookend\nother\nother\n", output);
    }

    [Fact]
    public void SlicePattern_TooShort_DoesNotMatch()
    {
        var gsource = """
            package Slice.TooShort
            import System

            func classify(xs []int32) {
                switch xs {
                    case [1, .., 3] { Console.WriteLine("bookend") }
                    default { Console.WriteLine("other") }
                }
            }

            classify([]int32{5})
            classify([]int32{})
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("other\nother\n", output);
    }

    [Fact]
    public void SlicePattern_SuffixOnly_BindsLastElement()
    {
        var gsource = """
            package Slice.SuffixOnly
            import System

            func ends(xs []int32) {
                switch xs {
                    case [.., l is int32] { Console.WriteLine("last=${l}") }
                    default { Console.WriteLine("empty") }
                }
            }

            ends([]int32{100, 200})
            ends([]int32{7})
            ends([]int32{})
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("last=200\nlast=7\nempty\n", output);
    }

    [Fact]
    public void SlicePattern_PrefixOnly_BindsFirstElement()
    {
        var gsource = """
            package Slice.PrefixOnly
            import System

            func heads(xs []int32) {
                switch xs {
                    case [f is int32, ..] { Console.WriteLine("first=${f}") }
                    default { Console.WriteLine("empty") }
                }
            }

            heads([]int32{42, 1, 2})
            heads([]int32{9})
            heads([]int32{})
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("first=42\nfirst=9\nempty\n", output);
    }

    [Fact]
    public void SlicePattern_DiscardSlice_MatchesAnyLength()
    {
        var gsource = """
            package Slice.AnyLength
            import System

            func any(xs []int32) {
                switch xs {
                    case [..] { Console.WriteLine("any") }
                    default { Console.WriteLine("never") }
                }
            }

            any([]int32{})
            any([]int32{1})
            any([]int32{1, 2, 3})
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("any\nany\nany\n", output);
    }

    [Fact]
    public void SlicePattern_CapturedRest_MaterializesMiddleSlice()
    {
        var gsource = """
            package Slice.Captured
            import System

            func describe(xs []int32) {
                switch xs {
                    case [f is int32, ..rest, l is int32] {
                        Console.WriteLine("first=${f} last=${l} restLen=${rest.Length}")
                    }
                    default { Console.WriteLine("nomatch") }
                }
            }

            describe([]int32{10, 20, 30, 40})
            describe([]int32{7, 8})
            describe([]int32{5})
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal(
            "first=10 last=40 restLen=2\nfirst=7 last=8 restLen=0\nnomatch\n",
            output);
    }

    [Fact]
    public void SlicePattern_CapturedRest_MiddleContentsAreCorrect()
    {
        var gsource = """
            package Slice.CapturedHead
            import System

            func mid(xs []int32) {
                switch xs {
                    case [_, ..rest, _] { Console.WriteLine("${rest[0]} ${rest[1]}") }
                    default { Console.WriteLine("nomatch") }
                }
            }

            mid([]int32{10, 20, 30, 40})
            """;

        var output = CompileAndRun(gsource);
        Assert.Equal("20 30\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1505_").FullName;
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}

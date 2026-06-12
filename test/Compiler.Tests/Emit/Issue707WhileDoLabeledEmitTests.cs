// <copyright file="Issue707WhileDoLabeledEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #707 / ADR-0070: end-to-end emit tests for the new <c>while</c>,
/// <c>do</c>-<c>while</c>, and labeled <c>break</c>/<c>continue</c>
/// statement forms. Verifies that the binder lowers each form to a
/// valid IL goto/label sequence and that running the produced assembly
/// produces the expected console output.
/// </summary>
public class Issue707WhileDoLabeledEmitTests
{
    [Fact]
    public void While_PrintsIterations()
    {
        var source = """
            package P
            import System

            var i = 0
            while i < 3 {
                Console.WriteLine(i)
                i = i + 1
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("0\n1\n2\n", output);
    }

    [Fact]
    public void DoWhile_RunsBodyAtLeastOnce_EvenWhenConditionFalse()
    {
        var source = """
            package P
            import System

            var i = 5
            do {
                Console.WriteLine(i)
                i = i + 1
            } while i < 5
            """;
        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void DoWhile_RunsBodyMultipleTimes_WhenConditionTrue()
    {
        var source = """
            package P
            import System

            var i = 0
            do {
                Console.WriteLine(i)
                i = i + 1
            } while i < 3
            """;
        var output = CompileAndRun(source);
        Assert.Equal("0\n1\n2\n", output);
    }

    [Fact]
    public void LabeledBreak_FromNestedFor_ExitsBothLoops()
    {
        var source = """
            package P
            import System

            outer: for var i = 0; i < 3; i++ {
                for var j = 0; j < 3; j++ {
                    if i == 1 && j == 1 {
                        Console.WriteLine("breaking")
                        break outer
                    }
                    Console.WriteLine("$i,$j")
                }
            }
            Console.WriteLine("done")
            """;
        var output = CompileAndRun(source);
        Assert.Equal("0,0\n0,1\n0,2\n1,0\nbreaking\ndone\n", output);
    }

    [Fact]
    public void LabeledContinue_SkipsToOuterPost()
    {
        var source = """
            package P
            import System

            outer: for var i = 0; i < 3; i++ {
                for var j = 0; j < 3; j++ {
                    if j == 1 {
                        continue outer
                    }
                    Console.WriteLine("$i,$j")
                }
            }
            """;
        var output = CompileAndRun(source);
        // Each i iteration prints only j=0 before continuing the outer loop.
        Assert.Equal("0,0\n1,0\n2,0\n", output);
    }

    [Fact]
    public void LabeledWhile_BreakFromInnerFor_ExitsLabeledWhile()
    {
        var source = """
            package P
            import System

            var n = 0
            outer: while n < 100 {
                for var j = 0; j < 5; j++ {
                    if j == 2 {
                        break outer
                    }
                    Console.WriteLine("$n-$j")
                }
                n = n + 1
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("0-0\n0-1\n", output);
    }

    [Fact]
    public void LabeledDoWhile_BreakFromInnerFor_ExitsLabeledDoWhile()
    {
        var source = """
            package P
            import System

            spin: do {
                for var j = 0; j < 5; j++ {
                    if j == 3 {
                        break spin
                    }
                    Console.WriteLine(j)
                }
            } while true
            Console.WriteLine("after")
            """;
        var output = CompileAndRun(source);
        Assert.Equal("0\n1\n2\nafter\n", output);
    }

    [Fact]
    public void UnlabeledBreakInLabeledOuter_OnlyExitsInnermost()
    {
        var source = """
            package P
            import System

            outer: for var i = 0; i < 2; i++ {
                for var j = 0; j < 5; j++ {
                    if j == 2 {
                        break
                    }
                    Console.WriteLine("$i-$j")
                }
            }
            """;
        var output = CompileAndRun(source);
        // For each i: j=0,1 before inner break. 2 i's.
        Assert.Equal("0-0\n0-1\n1-0\n1-1\n", output);
    }

    [Fact]
    public void TripleNested_LabeledBreak_TargetsOutermost()
    {
        var source = """
            package P
            import System

            a: for var i = 0; i < 3; i++ {
                b: for var j = 0; j < 3; j++ {
                    for var k = 0; k < 3; k++ {
                        if i == 0 && j == 1 && k == 2 {
                            break a
                        }
                        Console.WriteLine("$i$j$k")
                    }
                }
            }
            Console.WriteLine("end")
            """;
        var output = CompileAndRun(source);
        // Iterations: 000,001,002, 010,011 — then break a → end.
        Assert.Equal("000\n001\n002\n010\n011\nend\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue707_").FullName;
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

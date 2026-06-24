// <copyright file="Issue1027IncrementDecrementExpressionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1027 / ADR-0126: end-to-end emit + execution tests for prefix and
/// postfix increment (<c>++</c>) / decrement (<c>--</c>) used as
/// value-producing <em>expressions</em>. The post-form yields the value
/// <em>before</em> mutation; the pre-form yields the value <em>after</em>
/// mutation. The mutation must stay inside a short-circuited branch so that a
/// not-reached operand is never mutated. Each test compiles via <c>gsc</c> and
/// runs the produced assembly under <c>dotnet exec</c>.
/// </summary>
public class Issue1027IncrementDecrementExpressionEmitTests
{
    [Fact]
    public void PostfixDecrement_YieldsOldValue_AndMutates()
    {
        var source = """
            package main
            import System

            func run() {
                var i = 10
                var j = i--
                Console.WriteLine(j)
                Console.WriteLine(i)
            }

            run()
            """;

        Assert.Equal("10\n9\n", CompileAndRun(source));
    }

    [Fact]
    public void PrefixIncrement_YieldsNewValue_AndMutates()
    {
        var source = """
            package main
            import System

            func run() {
                var a = 5
                var k = ++a
                Console.WriteLine(k)
                Console.WriteLine(a)
            }

            run()
            """;

        Assert.Equal("6\n6\n", CompileAndRun(source));
    }

    [Fact]
    public void PostfixIncrement_InWhileShortCircuit_DecrementsOnlyWhenReached()
    {
        // The `i-- > 1` operand decrements once per loop iteration whose guard
        // is reached. With i starting at 3 the loop body runs while `i > 0`
        // is true AND the post-decrement-compare is true; we assert the final
        // counter to prove the decrement happened in-condition.
        var source = """
            package main
            import System

            func run() {
                var i = 3
                var iterations = 0
                for i > 0 && i-- > 1 {
                    iterations = iterations + 1
                }
                Console.WriteLine(iterations)
                Console.WriteLine(i)
            }

            run()
            """;

        // i: 3 -> guard true, (3>1) true, i=2, body; i=2 guard true, (2>1) true,
        // i=1, body; i=1 guard true, (1>1) false, i=0, stop. 2 iterations, i=0.
        Assert.Equal("2\n0\n", CompileAndRun(source));
    }

    [Fact]
    public void PostfixDecrement_RightOfFalseShortCircuit_DoesNotMutate()
    {
        var source = """
            package main
            import System

            func run() {
                var c = 0
                var cond = false
                if cond && c-- > -100 {
                    Console.WriteLine(99)
                }
                Console.WriteLine(c)
            }

            run()
            """;

        // `cond` is false, so the right operand `c--` is never evaluated.
        Assert.Equal("0\n", CompileAndRun(source));
    }

    [Fact]
    public void PostfixIncrement_OfArrayElement_YieldsOldValue_AndMutates()
    {
        var source = """
            package main
            import System

            func run() {
                var arr = []int32{100, 200}
                var e = arr[0]++
                Console.WriteLine(e)
                Console.WriteLine(arr[0])
                var p = --arr[1]
                Console.WriteLine(p)
                Console.WriteLine(arr[1])
            }

            run()
            """;

        Assert.Equal("100\n101\n199\n199\n", CompileAndRun(source));
    }

    [Fact]
    public void IncrementOfArrayElement_EvaluatesReceiverOnce()
    {
        var source = """
            package main
            import System

            var calls = 0
            var shared = []int32{50, 60}

            func getArr() []int32 {
                calls = calls + 1
                return shared
            }

            func run() {
                var v = getArr()[0]++
                Console.WriteLine(v)
                Console.WriteLine(shared[0])
                Console.WriteLine(calls)
            }

            run()
            """;

        // Old value 50, mutated to 51, and the receiver getArr() is evaluated
        // exactly once (single-evaluation of the indexed target's receiver).
        Assert.Equal("50\n51\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void IncrementDecrement_OfStructField_YieldsCorrectValues_AndMutates()
    {
        var source = """
            package main
            import System

            struct S { var x int32 }

            func run() {
                var s = S{x: 7}
                var f = s.x++
                Console.WriteLine(f)
                Console.WriteLine(s.x)
                var g = --s.x
                Console.WriteLine(g)
                Console.WriteLine(s.x)
            }

            run()
            """;

        Assert.Equal("7\n8\n7\n7\n", CompileAndRun(source));
    }

    [Fact]
    public void StatementForm_StillMutates_NoRegression()
    {
        var source = """
            package main
            import System

            func run() {
                var st = 3
                st++
                st--
                st++
                Console.WriteLine(st)
            }

            run()
            """;

        Assert.Equal("4\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1027_").FullName;
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

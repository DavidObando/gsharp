// <copyright file="Issue4350IndexRangeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0187 / issue #4350: prefix <c>^x</c> is a first-class
/// <c>System.Index</c> expression, standalone ranges accept from-end and saved
/// Index bounds, and unary one's-complement is spelled <c>~x</c>. Each program
/// is compiled, IL-verified, and executed.
/// </summary>
public class Issue4350IndexRangeEmitTests
{
    [Fact]
    public void SavedIndex_IndexesArraysStringsListsAndSpans()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            let xs = []int32{10, 20, 30, 40, 50}
            let last = ^1
            let third System.Index = ^3
            Console.WriteLine(xs[last])
            Console.WriteLine(xs[third])
            Console.WriteLine(third.IsFromEnd)
            Console.WriteLine(third.Value)
            Console.WriteLine(third.GetOffset(xs.Length))
            Console.WriteLine("gsharp"[last])
            let list = List[int32](xs)
            Console.WriteLine(list[third])
            let span = Span[int32](xs)
            Console.WriteLine(span[last])
            """;

        Assert.Equal(Lines("50", "30", "True", "3", "2", "p", "30", "50"), CompileAndRun(source));
    }

    [Fact]
    public void Index_FlowsThroughParametersReturnsFieldsGenericsAndNullable()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            func pick(xs []int32, i System.Index) int32 -> xs[i]

            func fromEnd(n int32) System.Index -> ^n

            class Holder {
                var At System.Index = ^2
            }

            let xs = []int32{10, 20, 30, 40, 50}
            Console.WriteLine(pick(xs, ^1))
            Console.WriteLine(pick(xs, fromEnd(4)))
            let holder = Holder()
            Console.WriteLine(xs[holder.At])
            holder.At = ^5
            Console.WriteLine(xs[holder.At])
            let ids = List[System.Index]()
            ids.Add(^1)
            ids.Add(^3)
            Console.WriteLine(xs[ids[1]])
            var maybe System.Index? = nil
            Console.WriteLine(maybe == nil)
            maybe = ^4
            Console.WriteLine(xs[maybe!!])
            let boxed object = ^2
            Console.WriteLine(boxed)
            """;

        Assert.Equal(Lines("50", "20", "40", "40", "10", "30", "True", "20", "^2"), CompileAndRun(source));
    }

    [Fact]
    public void StandaloneRanges_AcceptFromEndAndSavedIndexBounds()
    {
        var source = """
            package P
            import System

            let xs = []int32{10, 20, 30, 40, 50}
            func show(values []int32) {
                Console.WriteLine(String.Join(",", values))
            }

            let trimmed = ^4..^1
            show(xs[trimmed])
            let tail = ^3..
            show(xs[tail])
            let head = ..^2
            show(xs[head])
            let all = ..
            show(xs[all])
            let i = ^4
            let j System.Index = 4
            let saved = i..j
            show(xs[saved])
            show(xs[i..])
            show(xs[(^2)..])
            Console.WriteLine("abcdef"[^4..^1])
            Console.WriteLine(trimmed)
            """;

        Assert.Equal(
            Lines("20,30,40", "30,40,50", "10,20,30", "10,20,30,40,50", "20,30,40", "20,30,40,50", "40,50", "cde", "^4..^1"),
            CompileAndRun(source));
    }

    [Fact]
    public void NativeSlice_AcceptsSavedIndexAndLeadingFromEndRange()
    {
        var source = """
            package P
            import System

            let values = slice[int32]{10, 20, 30, 40, 50}
            let last = ^1
            Console.WriteLine(values[last])
            let middle = values[^4..^1]
            Console.WriteLine(middle.Length)
            Console.WriteLine(middle[0])
            let i = ^2
            let tail = values[i..]
            Console.WriteLine(tail.Length)
            Console.WriteLine(tail[0])
            """;

        Assert.Equal(Lines("50", "3", "20", "2", "40"), CompileAndRun(source));
    }

    [Fact]
    public void IndexAndRangeBounds_EvaluateOnceLeftToRight()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            func tick(log List[string], name string, value int32) int32 {
                log.Add(name)
                return value
            }

            let log = List[string]()
            let xs = []int32{10, 20, 30, 40, 50}
            let r = ^tick(log, "a", 3)..^tick(log, "b", 1)
            Console.WriteLine(String.Join(",", log))
            Console.WriteLine(String.Join(",", xs[r]))
            log.Clear()
            let i = ^tick(log, "c", 2)
            Console.WriteLine(xs[i] + xs[i])
            Console.WriteLine(String.Join(",", log))
            log.Clear()
            let s = xs[^tick(log, "d", 4)..tick(log, "e", 3)]
            Console.WriteLine(String.Join(",", s))
            Console.WriteLine(String.Join(",", log))
            """;

        Assert.Equal(Lines("a,b", "30,40", "80", "c", "20,30", "d,e"), CompileAndRun(source));
    }

    [Fact]
    public void FromEndIndex_PreservesClrExceptionBehavior()
    {
        var source = """
            package P
            import System

            let xs = []int32{10, 20, 30}
            let zero = ^0
            Console.WriteLine(zero.GetOffset(xs.Length))
            try {
                Console.WriteLine(xs[zero])
            } catch (e IndexOutOfRangeException) {
                Console.WriteLine("index")
            }

            var n = -1
            try {
                let bad = ^n
                Console.WriteLine(bad)
            } catch (e ArgumentOutOfRangeException) {
                Console.WriteLine("argument")
            }
            """;

        Assert.Equal(Lines("3", "index", "argument"), CompileAndRun(source));
    }

    [Fact]
    public void Tilde_IsOnesComplement_AndBinaryHatStaysXor()
    {
        var source = """
            package P
            import System
            import System.IO

            struct Bits(Value int32) {
            }

            func (a Bits) operator ~() Bits -> Bits{Value: ~a.Value}

            enum Mask { None = 0, All = ~0 }

            const Complement = ~15u
            let five = 5
            Console.WriteLine(~five)
            Console.WriteLine(~0u)
            Console.WriteLine(Complement)
            Console.WriteLine(int32(~FileShare.None))
            Console.WriteLine(int32(Mask.All))
            Console.WriteLine((~Bits{Value: 6}).Value)
            Console.WriteLine(6 ^ 3)
            var x = 6
            x ^= 3
            Console.WriteLine(x)
            let xs = []int32{10, 20, 30, 40, 50}
            Console.WriteLine(xs[~-3])
            Console.WriteLine(xs[1 ^ 2])
            """;

        Assert.Equal(
            Lines("-6", "4294967295", "4294967280", "-1", "-1", "-7", "5", "5", "30", "40"),
            CompileAndRun(source));
    }

    private static string Lines(params string[] lines)
        => string.Concat(Array.ConvertAll(lines, line => line + Environment.NewLine));

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4350_emit_").FullName;
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

            using var proc = Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
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

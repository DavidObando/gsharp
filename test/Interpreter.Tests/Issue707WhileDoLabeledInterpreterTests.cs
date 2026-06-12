// <copyright file="Issue707WhileDoLabeledInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #707 / ADR-0070: interpreter parity for the new <c>while</c>,
/// <c>do</c>-<c>while</c>, and labeled <c>break</c>/<c>continue</c>
/// statement forms. The interpreter shares the binder with the emit
/// pipeline, so accepting the syntax is essentially automatic — these
/// tests pin down end-to-end behavior on the interpreter path.
/// </summary>
public class Issue707WhileDoLabeledInterpreterTests
{
    [Fact]
    public void While_PrintsThreeIterations()
    {
        var source = """
            var i = 0
            while i < 3 {
                Console.WriteLine(i)
                i = i + 1
            }
            """;
        var output = RunSubmission(source);
        // The interpreter prints `0\n1\n2\n` from the WriteLine calls; the
        // REPL also prints the final value of i (3) on its own line.
        Assert.Contains("0", output);
        Assert.Contains("1", output);
        Assert.Contains("2", output);
        Assert.DoesNotContain("4", output);
    }

    [Fact]
    public void DoWhile_AlwaysRunsBodyOnce()
    {
        // The body must run once even when the condition is initially false.
        var source = """
            var i = 5
            do {
                Console.WriteLine(i)
                i = i + 1
            } while i < 5
            """;
        var output = RunSubmission(source);
        Assert.Contains("5", output);
        Assert.DoesNotContain("7", output);
    }

    [Fact]
    public void LabeledBreak_FromNestedFor_ExitsOuter()
    {
        var source = """
            var hits = 0
            outer: for var i = 0; i < 3; i++ {
                for var j = 0; j < 3; j++ {
                    if i == 1 && j == 1 {
                        break outer
                    }
                    hits = hits + 1
                }
            }
            Console.WriteLine(hits)
            """;
        var output = RunSubmission(source);
        // Visited iterations: (0,0)(0,1)(0,2)(1,0) = 4 before breakout.
        Assert.Contains("4", output);
    }

    [Fact]
    public void LabeledContinue_SkipsToOuterPost()
    {
        var source = """
            var hits = 0
            outer: for var i = 0; i < 3; i++ {
                for var j = 0; j < 3; j++ {
                    if j == 1 {
                        continue outer
                    }
                    hits = hits + 1
                }
            }
            Console.WriteLine(hits)
            """;
        var output = RunSubmission(source);
        // For each i we only run j=0 (one increment) then skip to outer.
        // 3 i-iterations * 1 hit = 3.
        Assert.Contains("3", output);
    }

    [Fact]
    public void LabeledWhile_BreakFromInnerFor_ExitsWhile()
    {
        var source = """
            var hits = 0
            var run = true
            outer: while run {
                for var j = 0; j < 5; j++ {
                    if j == 2 {
                        break outer
                    }
                    hits = hits + 1
                }
            }
            Console.WriteLine(hits)
            """;
        var output = RunSubmission(source);
        Assert.Contains("2", output);
    }

    [Fact]
    public void LabeledDoWhile_BreakFromInner_ExitsDoWhile()
    {
        var source = """
            var hits = 0
            spin: do {
                for var j = 0; j < 5; j++ {
                    if j == 2 {
                        break spin
                    }
                    hits = hits + 1
                }
            } while true
            Console.WriteLine(hits)
            """;
        var output = RunSubmission(source);
        Assert.Contains("2", output);
    }

    [Fact]
    public void UnlabeledBreakInsideNestedLabeledLoop_ExitsOnlyInnermost()
    {
        var source = """
            var hits = 0
            outer: for var i = 0; i < 2; i++ {
                for var j = 0; j < 5; j++ {
                    if j == 2 {
                        break
                    }
                    hits = hits + 1
                }
            }
            Console.WriteLine(hits)
            """;
        var output = RunSubmission(source);
        // For each i: j=0,1 hit before inner break, so 2 per i, 2 i's = 4.
        Assert.Contains("4", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}

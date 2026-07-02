// <copyright file="Issue1712NaNBinaryOperatorInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1712: the tree-walking evaluator's binary relational operators
/// (<c>&lt;</c>, <c>&lt;=</c>, <c>&gt;</c>, <c>&gt;=</c>) routed through
/// <c>NumericCompare</c>, which uses <c>IComparable.CompareTo</c>.
/// <c>double</c>/<c>float</c>.CompareTo sorts <c>NaN</c> as lower than every
/// value, so <c>NaN &lt; x</c> wrongly returned <c>true</c> and
/// <c>NaN &gt;= x</c> wrongly returned <c>false</c>. Per IEEE-754 (and the
/// emitter's unordered opcodes, #421), every ordered comparison involving
/// <c>NaN</c> must be <c>false</c>. #1653 already fixed the identical defect
/// on the relational-pattern path; these tests pin down parity on the
/// binary-operator path for both <c>float32</c> and <c>float64</c>.
/// </summary>
public class Issue1712NaNBinaryOperatorInterpreterTests
{
    [Fact]
    public void Double_NaN_AllOrderedComparisons_AreFalse()
    {
        var output = RunSubmission(
            """
            let nan = 0.0 / 0.0
            let one = 1.0
            Console.WriteLine(nan < one)
            Console.WriteLine(one < nan)
            Console.WriteLine(nan <= one)
            Console.WriteLine(one <= nan)
            Console.WriteLine(nan > one)
            Console.WriteLine(one > nan)
            Console.WriteLine(nan >= one)
            Console.WriteLine(one >= nan)
            """);
        Assert.DoesNotContain("error GS", output);
        Assert.Equal(
            "False\nFalse\nFalse\nFalse\nFalse\nFalse\nFalse\nFalse\n",
            output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void Float32_NaN_AllOrderedComparisons_AreFalse()
    {
        var output = RunSubmission(
            """
            let nan = float32(0.0 / 0.0)
            let one = float32(1.0)
            Console.WriteLine(nan < one)
            Console.WriteLine(one < nan)
            Console.WriteLine(nan <= one)
            Console.WriteLine(one <= nan)
            Console.WriteLine(nan > one)
            Console.WriteLine(one > nan)
            Console.WriteLine(nan >= one)
            Console.WriteLine(one >= nan)
            """);
        Assert.DoesNotContain("error GS", output);
        Assert.Equal(
            "False\nFalse\nFalse\nFalse\nFalse\nFalse\nFalse\nFalse\n",
            output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void Double_NaN_Equality_AlreadyCorrect()
    {
        // Regression guard: NaN == NaN is false, NaN != NaN is true — these
        // don't go through NumericCompare and were already correct.
        var output = RunSubmission(
            """
            let nan = 0.0 / 0.0
            Console.WriteLine(nan == nan)
            Console.WriteLine(nan != nan)
            """);
        Assert.DoesNotContain("error GS", output);
        Assert.Equal("False\nTrue\n", output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void Double_NormalOrdering_StillWorks()
    {
        // Non-NaN comparisons must be unaffected by the guard.
        var output = RunSubmission(
            """
            let a = 1.5
            let b = 2.5
            Console.WriteLine(a < b)
            Console.WriteLine(b < a)
            Console.WriteLine(a <= a)
            Console.WriteLine(b >= a)
            Console.WriteLine(a > b)
            Console.WriteLine(b > a)
            """);
        Assert.DoesNotContain("error GS", output);
        Assert.Equal(
            "True\nFalse\nTrue\nTrue\nFalse\nTrue\n",
            output.Replace("\r\n", "\n"));
    }

    [Fact]
    public void Int_And_Decimal_Ordering_Unaffected()
    {
        // Non-floating-point relational comparisons must not be affected by
        // the NaN guard (IsNaN returns false for non-float/double operands).
        var output = RunSubmission(
            """
            let i1 = 3
            let i2 = 5
            let d1 = 3.0m
            let d2 = 5.0m
            Console.WriteLine(i1 < i2)
            Console.WriteLine(i2 <= i1)
            Console.WriteLine(d1 < d2)
            Console.WriteLine(d2 >= d1)
            """);
        Assert.DoesNotContain("error GS", output);
        Assert.Equal("True\nFalse\nTrue\nTrue\n", output.Replace("\r\n", "\n"));
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

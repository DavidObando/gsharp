// <copyright file="Issue715ArrowFunctionTypeClauseInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #715 / ADR-0075 — interpreter parity for the canonical arrow-form
/// function-type clause <c>(T) -&gt; R</c>. Mirrors the emit-side coverage in
/// <c>Issue715ArrowFunctionTypeClauseEmitTests</c>.
/// </summary>
public class Issue715ArrowFunctionTypeClauseInterpreterTests
{
    [Fact]
    public void ArrowFunctionType_OnLocal_AcceptsLambdaInitializer()
    {
        var source = "let add (int32, int32) -> int32 = (a int32, b int32) -> a + b\nadd(20, 22)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
        Assert.DoesNotContain("GS0303", output);
    }

    [Fact]
    public void ArrowFunctionType_OnLocal_AcceptsMethodGroup()
    {
        var source = "func twice(x int32) int32 { return x * 2 }\nlet g (int32) -> int32 = twice\ng(21)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
        Assert.DoesNotContain("GS0303", output);
    }

    [Fact]
    public void ArrowFunctionType_PassingLambdaThroughParameter_Works()
    {
        var source = "func apply(f (int32) -> int32, v int32) int32 { return f(v) }\napply((x int32) -> x * 3, 14)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
        Assert.DoesNotContain("GS0303", output);
    }

    [Fact]
    public void ArrowFunctionType_ReturnedFromFunction_Works()
    {
        var source = "func makeAdder(d int32) (int32) -> int32 { return (x int32) -> x + d }\nlet addTen = makeAdder(10)\naddTen(32)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void ArrowFunctionType_TupleReturn_Works()
    {
        var source = "func split(s string) (string, int32) { return (s, s.Length) }\nlet splitter (string) -> (string, int32) = split\nlet t = splitter(\"hello\")\nt.Item2";
        var output = RunSubmission(source);
        Assert.Contains("5", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void ArrowAndLegacyForms_AreInterchangeable_LegacyWarns_GS0303()
    {
        var source = "let add = func(a int32, b int32) int32 { return a + b }\nlet f1 (int32, int32) -> int32 = add\nlet f2 func(int32, int32) int32 = f1\nf2(40, 2)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
        // Exactly the legacy slot on `f2` triggers GS0303.
        Assert.Contains("GS0303", output);
    }

    [Fact]
    public void LegacyFuncForm_StillEvaluates_EmitsGS0303()
    {
        var source = "let inc func(int32) int32 = (x int32) -> x + 1\ninc(41)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.Contains("GS0303", output);
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

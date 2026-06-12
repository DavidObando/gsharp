// <copyright file="Issue711IfExpressionInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #711 / ADR-0064 — interpreter parity for `if` used as a
/// value-producing expression. The interpreter shares the binder with the
/// emit pipeline, so the binding rules are common; this file pins down the
/// REPL/evaluator execution semantics (only one arm is evaluated, the
/// multi-statement block lifts its trailing expression, throw in a branch
/// prefix propagates, etc.).
/// </summary>
public class Issue711IfExpressionInterpreterTests
{
    [Fact]
    public void IfExpression_TrueArm_YieldsThenValue()
    {
        var source = """
            var cond = true
            let x = if cond { 11 } else { 22 }
            Console.WriteLine(x)
            """;

        Assert.Equal("11\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_FalseArm_YieldsElseValue()
    {
        var source = """
            var cond = false
            let x = if cond { 11 } else { 22 }
            Console.WriteLine(x)
            """;

        Assert.Equal("22\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_ElseIfChain_PicksFirstMatchingArm()
    {
        var source = """
            var score = 85
            let grade = if score >= 90 { "A" } else if score >= 80 { "B" } else { "C" }
            Console.WriteLine(grade)
            """;

        Assert.Equal("B\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_ElseIfChain_LastArmFiresWhenNothingMatches()
    {
        var source = """
            var score = 50
            let grade = if score >= 90 { "A" } else if score >= 80 { "B" } else { "C" }
            Console.WriteLine(grade)
            """;

        Assert.Equal("C\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_Nested_RoutesThroughInnerArm()
    {
        var source = """
            var a = true
            var b = false
            let n = if a { if b { 1 } else { 2 } } else { 3 }
            Console.WriteLine(n)
            """;

        Assert.Equal("2\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_MultiStatementBlock_LiftsTrailingValue()
    {
        var source = """
            var sink = ""
            let title = if true {
                sink = "side-effect"
                "Admin"
            } else {
                "Home"
            }
            Console.WriteLine(title)
            Console.WriteLine(sink)
            """;

        Assert.Equal("Admin\nside-effect\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_AsCallArgument()
    {
        var source = """
            var flag = true
            Console.WriteLine(if flag { "on" } else { "off" })
            """;

        Assert.Equal("on\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_InReturn_PropagatesValue()
    {
        var source = """
            func Pick(b bool) int32 {
                return if b { 1 } else { -1 }
            }
            Console.WriteLine(Pick(true))
            Console.WriteLine(Pick(false))
            """;

        Assert.Equal("1\n-1\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_TypeInference_OnLetInitializer()
    {
        var source = """
            var x = 10
            let result = if x > 5 { x * 2 } else { x + 1 }
            Console.WriteLine(result)
            """;

        Assert.Equal("20\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_OnlyChosenArmIsEvaluated()
    {
        // The false-arm has a divide-by-zero — it MUST not execute when
        // the condition is true.
        var source = """
            var d = 0
            let x = if true { 7 } else { 100 / d }
            Console.WriteLine(x)
            """;

        Assert.Equal("7\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_NumericWideningAtBranchTail()
    {
        var source = """
            var a int32 = 1
            var b int64 = 2
            let x = if true { a } else { b }
            Console.WriteLine(x)
            """;

        Assert.Equal("1\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_NilArm_BindsAsNullable()
    {
        var source = """
            var s string? = "hi"
            let x = if true { s } else { nil }
            if let v = x {
                Console.WriteLine(v)
            } else {
                Console.WriteLine("nil")
            }
            """;

        Assert.Equal("hi\n", RunSubmission(source));
    }

    [Fact]
    public void IfExpression_ThrowInBranchPrefix_PropagatesAtRuntime()
    {
        // The throw in the then-arm fires only when cond is true; the
        // else-arm continues normally.
        var source = """
            func Run(b bool) int32 {
                let x = if b {
                    throw Exception(message = "boom")
                    0
                } else {
                    7
                }
                return x
            }
            Console.WriteLine(Run(false))
            """;

        Assert.Equal("7\n", RunSubmission(source));
    }

    [Fact]
    public void IfStatement_StillWorks_Unchanged()
    {
        // Regression guard: an `if` statement (no else, no value position)
        // continues to behave as it did before ADR-0064.
        var source = """
            var x = 0
            if true {
                x = 42
            }
            Console.WriteLine(x)
            """;

        Assert.Equal("42\n", RunSubmission(source));
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

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}

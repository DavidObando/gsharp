// <copyright file="Adr0151IfLetExpressionEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0151 emitted-session coverage for the value-producing <c>if let</c>
/// expression. Pins which branch runs, that each initializer executes exactly
/// once, and that a failed binding short-circuits every later initializer and
/// the guard.
/// </summary>
public class Adr0151IfLetExpressionEmittedSessionTests
{
    [Fact]
    public void IfLetExpression_Match_YieldsThenValue()
    {
        var source = """
            func Run(s string?) string {
                return if let v = s { v } else { "none" }
            }
            Console.WriteLine(Run("hi"))
            """;

        Assert.Equal($"hi{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_Nil_YieldsElseValue()
    {
        var source = """
            func Run(s string?) string {
                return if let v = s { v } else { "none" }
            }
            Console.WriteLine(Run(nil))
            """;

        Assert.Equal($"none{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_GuardFalse_YieldsElseValue()
    {
        var source = """
            func Run(s string?) string {
                return if let v = s && v.Length > 3 { v } else { "short" }
            }
            Console.WriteLine(Run("hi"))
            Console.WriteLine(Run("hello"))
            """;

        Assert.Equal($"short{Environment.NewLine}hello{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_EvaluatesInitializerExactlyOnce()
    {
        var source = """
            var calls = 0
            func Source() string? {
                calls = calls + 1
                return "x"
            }
            let v = if let s = Source() { s } else { "none" }
            Console.WriteLine(v)
            Console.WriteLine(calls)
            """;

        Assert.Equal($"x{Environment.NewLine}1{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_ShortCircuits_LaterInitializerOnNilBinding()
    {
        // The first binding fails, so `Second()` must never run.
        var source = """
            var secondCalls = 0
            func First() string? {
                return nil
            }
            func Second() string? {
                secondCalls = secondCalls + 1
                return "b"
            }
            let v = if let a = First(), let b = Second() { b } else { "none" }
            Console.WriteLine(v)
            Console.WriteLine(secondCalls)
            """;

        Assert.Equal($"none{Environment.NewLine}0{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_ShortCircuits_GuardOnNilBinding()
    {
        var source = """
            var guardCalls = 0
            func Check() bool {
                guardCalls = guardCalls + 1
                return true
            }
            func Source() string? {
                return nil
            }
            let v = if let s = Source() && Check() { s } else { "none" }
            Console.WriteLine(v)
            Console.WriteLine(guardCalls)
            """;

        Assert.Equal($"none{Environment.NewLine}0{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_MultipleBindings_EvaluateLeftToRight()
    {
        var source = """
            var log = ""
            func A() string? {
                log = log + "a"
                return "A"
            }
            func B() string? {
                log = log + "b"
                return "B"
            }
            let v = if let x = A(), let y = B() { x + y } else { "none" }
            Console.WriteLine(v)
            Console.WriteLine(log)
            """;

        Assert.Equal($"AB{Environment.NewLine}ab{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_LaterInitializerSeesEarlierBinding()
    {
        var source = """
            func Wrap(a string) string? {
                return a + "!"
            }
            func Run(s string?) string {
                return if let first = s, let second = Wrap(first) { second } else { "none" }
            }
            Console.WriteLine(Run("hi"))
            Console.WriteLine(Run(nil))
            """;

        Assert.Equal($"hi!{Environment.NewLine}none{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_NullableValueTypeBinding()
    {
        var source = """
            func Run(n int32?) int32 {
                return if let v = n && v > 0 { v } else { -1 }
            }
            Console.WriteLine(Run(3))
            Console.WriteLine(Run(-3))
            Console.WriteLine(Run(nil))
            """;

        Assert.Equal($"3{Environment.NewLine}-1{Environment.NewLine}-1{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_ElseIfLetChain_PicksFirstMatchingArm()
    {
        var source = """
            func Run(a string?, b string?) string {
                return if let x = a { x } else if let y = b { y } else { "none" }
            }
            Console.WriteLine(Run("a", "b"))
            Console.WriteLine(Run(nil, "b"))
            Console.WriteLine(Run(nil, nil))
            """;

        Assert.Equal($"a{Environment.NewLine}b{Environment.NewLine}none{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetExpression_BlockPrefixStatementsRunBeforeTheTail()
    {
        var source = """
            func Run(s string?) int32 {
                return if let v = s {
                    let n = v.Length
                    n + 1
                } else {
                    0
                }
            }
            Console.WriteLine(Run("abc"))
            """;

        Assert.Equal($"4{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IfLetStatement_StillWorks_Unchanged()
    {
        // Regression guard: the ADR-0071 statement form is untouched.
        var source = """
            var x = 0
            func Run(s string?) {
                if let v = s {
                    x = v.Length
                } else {
                    x = -1
                }
            }
            Run("abcd")
            Console.WriteLine(x)
            Run(nil)
            Console.WriteLine(x)
            """;

        Assert.Equal($"4{Environment.NewLine}-1{Environment.NewLine}", RunSubmission(source));
    }

    private static string RunSubmission(string text)
    {
        // ADR-0156 Phase 3c (#3176): submissions run on the emitted engine.
        using var engine = new EmittedSessionEngine { CaptureConsole = true };
        var cell = engine.Evaluate(text);
        Assert.DoesNotContain(cell.Diagnostics, d => d.Id != "GS0286");
        return cell.Output.ReplaceLineEndings(Environment.NewLine);
    }
}

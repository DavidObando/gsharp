// <copyright file="Issue708IfLetGuardLetInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #708 / ADR-0071 — interpreter parity for <c>if let</c> and
/// <c>guard let</c> nullable-binding statements. The interpreter shares
/// the binder with the emit pipeline, so accepting the syntax is largely
/// automatic — these tests pin down end-to-end behavior on the
/// interpreter path.
/// </summary>
public class Issue708IfLetGuardLetInterpreterTests
{
    [Fact]
    public void IfLet_RunsThenWhenNonNil()
    {
        var source = """
            func Demo(s string?) {
                if let v = s {
                    Console.WriteLine("got:" + v)
                }
            }
            Demo("hello")
            Demo(nil)
            """;
        var output = RunSubmission(source);
        Assert.Contains("got:hello", output);
        Assert.DoesNotContain("got:nil", output);
    }

    [Fact]
    public void IfLetElse_RoutesToElseOnNil()
    {
        var source = """
            func Demo(s string?) {
                if let v = s {
                    Console.WriteLine("got:" + v)
                } else {
                    Console.WriteLine("nil")
                }
            }
            Demo("x")
            Demo(nil)
            """;
        var output = RunSubmission(source);
        Assert.Contains("got:x", output);
        Assert.Contains("nil", output);
    }

    [Fact]
    public void IfLet_MultipleBindings_RequiresAllNonNil()
    {
        var source = """
            func Demo(a string?, b string?) {
                if let x = a, let y = b {
                    Console.WriteLine("both:" + x + "/" + y)
                } else {
                    Console.WriteLine("missing")
                }
            }
            Demo("a", "b")
            Demo("a", nil)
            Demo(nil, "b")
            """;
        var output = RunSubmission(source);
        Assert.Contains("both:a/b", output);
        var missingCount = 0;
        foreach (var line in output.Split('\n'))
        {
            if (line.Contains("missing"))
            {
                missingCount++;
            }
        }

        Assert.Equal(2, missingCount);
    }

    [Fact]
    public void GuardLet_FallsThroughOnNonNil_ExitsOnNil()
    {
        var source = """
            func Demo(s string?) {
                guard let v = s else {
                    Console.WriteLine("exit")
                    return
                }
                Console.WriteLine("ok:" + v)
            }
            Demo("hi")
            Demo(nil)
            """;
        var output = RunSubmission(source);
        Assert.Contains("ok:hi", output);
        Assert.Contains("exit", output);
    }

    [Fact]
    public void GuardLet_MultipleBindings_FirstNilExits()
    {
        var source = """
            func Demo(a string?, b string?) {
                guard let x = a, let y = b else {
                    Console.WriteLine("exit")
                    return
                }
                Console.WriteLine("both:" + x + "/" + y)
            }
            Demo("a", "b")
            Demo("a", nil)
            Demo(nil, "b")
            """;
        var output = RunSubmission(source);
        Assert.Contains("both:a/b", output);
        var exitCount = 0;
        foreach (var line in output.Split('\n'))
        {
            if (line.Contains("exit"))
            {
                exitCount++;
            }
        }

        Assert.Equal(2, exitCount);
    }

    [Fact]
    public void IfLet_NarrowedBindingExposesUnderlyingMembers()
    {
        // Inside the then-branch, `v` is narrowed to `string` and `.Length`
        // is callable without a further guard.
        var source = """
            func Demo(s string?) {
                if let v = s {
                    Console.WriteLine(v.Length)
                }
            }
            Demo("abcd")
            Demo(nil)
            """;
        var output = RunSubmission(source);
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

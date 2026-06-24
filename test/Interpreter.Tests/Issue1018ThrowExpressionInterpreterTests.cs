// <copyright file="Issue1018ThrowExpressionInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1018 — interpreter parity for throw-expressions. The evaluator
/// reuses the throw-statement raising path for a <c>BoundThrowExpression</c>,
/// so <c>x ?? throw e</c> and <c>cond ? a : throw e</c> behave end-to-end the
/// same as the emit suite: the non-throwing path yields its value, the
/// throwing path raises the exception.
/// </summary>
public class Issue1018ThrowExpressionInterpreterTests
{
    [Fact]
    public void NullCoalesceThrow_NonNull_YieldsValue()
    {
        var source = """
            func firstNonNull(s string?) string {
                return s ?? throw Exception("was null")
            }
            Console.WriteLine(firstNonNull("hello"))
            """;
        var output = RunSubmission(source);
        Assert.Contains("hello", output);
    }

    [Fact]
    public void NullCoalesceThrow_Null_Raises()
    {
        var source = """
            func firstNonNull(s string?) string {
                return s ?? throw Exception("boom-null")
            }
            var got = "none"
            try {
                firstNonNull(nil)
            } catch (e Exception) {
                got = e.Message
            }
            Console.WriteLine(got)
            """;
        var output = RunSubmission(source);
        Assert.Contains("boom-null", output);
    }

    [Fact]
    public void TernaryThrow_TrueBranch_YieldsValue()
    {
        var source = """
            func pick(cond bool, a int32) int32 {
                return cond ? a : throw Exception("nope")
            }
            Console.WriteLine(pick(true, 42))
            """;
        var output = RunSubmission(source);
        Assert.Contains("42", output);
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

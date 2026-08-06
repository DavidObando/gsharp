// <copyright file="ParenthesizedReceiverEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0054: postfix member/index access on primary expressions. Verifies that
/// the emitted REPL session evaluates member access, method calls, and indexing
/// through a parenthesized receiver to the exact expected value.
/// </summary>
public class ParenthesizedReceiverEmittedSessionTests
{
    [Theory]
    [InlineData("(10 + 32).GetType()", "System.Int32")]
    [InlineData("(10 + 32).ToString()", "\"42\"")] // string result echoes quoted (ADR-0157 display formatter)
    [InlineData("(\"hello\").Length", "5")]
    [InlineData("([3]int32{10, 20, 30})[1]", "20")]
    public void EmittedSession_ParenthesizedReceiver_PrintsExpectedValue(string expr, string expected)
    {
        var output = RunSubmission(expr);
        Assert.Equal(expected + Environment.NewLine, output);
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

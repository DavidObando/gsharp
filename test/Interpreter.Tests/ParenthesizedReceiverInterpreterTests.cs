// <copyright file="ParenthesizedReceiverInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0054: postfix member/index access on primary expressions. Verifies that
/// the interpreter (a separate execution path from the emitter) evaluates
/// member access, method calls, and indexing through a parenthesized receiver
/// with the same results the compiled program produces.
/// </summary>
public class ParenthesizedReceiverInterpreterTests
{
    [Theory]
    [InlineData("(10 + 32).GetType()", "System.Int32")]
    [InlineData("(10 + 32).ToString()", "42")]
    [InlineData("(\"hello\").Length", "5")]
    [InlineData("([3]int32{10, 20, 30})[1]", "20")]
    public void Interpreter_ParenthesizedReceiver_MatchesEmitter(string expr, string expectedContains)
    {
        var output = RunSubmission(expr);
        Assert.Contains(expectedContains, output);
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

// <copyright file="GSharpReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class GSharpReplTests
{
    [Fact]
    public void EvaluateSubmission_SimpleExpression_WritesValue()
    {
        var output = RunSubmission("1 + 2");
        Assert.Contains("3", output);
    }

    [Fact]
    public void EvaluateSubmission_StringLiteral_WritesValue()
    {
        var output = RunSubmission("\"hello\"");
        Assert.Contains("hello", output);
    }

    [Fact]
    public void EvaluateSubmission_InvalidInput_WritesDiagnostics()
    {
        var output = RunSubmission("1 +");
        Assert.False(string.IsNullOrWhiteSpace(output));
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

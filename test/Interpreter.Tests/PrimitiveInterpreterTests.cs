// <copyright file="PrimitiveInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Phase 5 of #142: interpreter parity for the expanded numeric
/// primitive set. Each test feeds a snippet through the REPL and
/// asserts that the printed value matches what the emitter produces
/// in the equivalent compiled program.
/// </summary>
public class PrimitiveInterpreterTests
{
    [Theory]
    [InlineData("100L + 50L", "150")]
    [InlineData("100L - 50L", "50")]
    [InlineData("100L * 2L", "200")]
    [InlineData("100L / 50L", "2")]
    [InlineData("100L % 30L", "10")]
    [InlineData("9000000000UL / 3UL", "3000000000")]
    [InlineData("1.5 + 2.25", "3.75")]
    [InlineData("10.0 / 4.0", "2.5")]
    [InlineData("1.5M + 2.25M", "3.75")]
    [InlineData("10M * 7M", "70")]
    [InlineData("1L << 10", "1024")]
    [InlineData("1024L >> 2", "256")]
    [InlineData("100L < 200L", "True")]
    [InlineData("100L == 100L", "True")]
    [InlineData("-42L", "-42")]
    [InlineData("-3.14M", "-3.14")]
    [InlineData("long(42)", "42")]
    [InlineData("int(9999999999L)", "1410065407")]
    public void Interpreter_PrimitiveArithmetic_MatchesEmitter(string expr, string expectedContains)
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

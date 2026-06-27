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

    // Issue #1232: shift count masking matches C#/CLR (`& 0x1F` for 32-bit
    // operands, `& 0x3F` for 64-bit operands), not Go's "count >= width = 0".
    [InlineData("1 << 33", "2")]
    [InlineData("1 << 32", "1")]
    [InlineData("100 >> 32", "100")]
    [InlineData("1L << 64", "1")]
    [InlineData("1L << 100", "68719476736")]
    [InlineData("1024L >> 64", "1024")]
    [InlineData("uint32(1) << 32", "1")]
    [InlineData("uint64(1) << 64", "1")]

    // Boundary: shift by exactly width-1 still works normally.
    [InlineData("1 << 31", "-2147483648")]
    [InlineData("uint32(1) << 31", "2147483648")]
    [InlineData("100L < 200L", "True")]
    [InlineData("100L == 100L", "True")]
    [InlineData("-42L", "-42")]
    [InlineData("-3.14M", "-3.14")]
    [InlineData("int64(42)", "42")]
    [InlineData("int32(9999999999L)", "1410065407")]

    // Issue #1183 (C# §6.4.5.3): un-suffixed literals that exceed int32 infer
    // a wider type and evaluate to the correct value in the tree interpreter.
    [InlineData("4294967295", "4294967295")]
    [InlineData("5000000000", "5000000000")]
    [InlineData("18446744073709551615", "18446744073709551615")]
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

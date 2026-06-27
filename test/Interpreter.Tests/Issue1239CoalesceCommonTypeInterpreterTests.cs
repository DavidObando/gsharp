// <copyright file="Issue1239CoalesceCommonTypeInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1239: interpreter parity for the null-coalescing (<c>??</c>) best
/// common type. When the left's non-null type implicitly converts to the right
/// operand's type (a reference upcast / interface implementation or a numeric
/// widening) — or vice versa — <c>??</c> evaluates to a value of the computed
/// best common type, mirroring the emitted IL behaviour validated by
/// <c>Issue1239CoalesceCommonTypeEmitTests</c>.
/// </summary>
public class Issue1239CoalesceCommonTypeInterpreterTests
{
    [Fact]
    public void NumericWidening_RightWidensToLeftUnderlying_LeftPresent()
    {
        var source = """
            let a int32? = 100
            let b uint16 = 7
            Console.WriteLine((a ?? b).ToString())
            """;

        Assert.Equal("100\n", RunSubmission(source));
    }

    [Fact]
    public void NumericWidening_RightWidensToLeftUnderlying_LeftNil()
    {
        var source = """
            let a int32? = nil
            let b uint16 = 7
            Console.WriteLine((a ?? b).ToString())
            """;

        Assert.Equal("7\n", RunSubmission(source));
    }

    [Fact]
    public void NumericWidening_LeftWidensToRight_LeftPresent_ConvertsToResultType()
    {
        var source = """
            let a int32? = 100
            let b int64 = 9000000000
            Console.WriteLine((a ?? b).ToString())
            """;

        Assert.Equal("100\n", RunSubmission(source));
    }

    [Fact]
    public void NumericWidening_LeftWidensToRight_LeftNil()
    {
        var source = """
            let a int32? = nil
            let b int64 = 9000000000
            Console.WriteLine((a ?? b).ToString())
            """;

        Assert.Equal("9000000000\n", RunSubmission(source));
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

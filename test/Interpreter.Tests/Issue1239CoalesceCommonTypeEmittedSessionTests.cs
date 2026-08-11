// <copyright file="Issue1239CoalesceCommonTypeEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1239: Emitted-session coverage for coalesce common type.
/// </summary>
public class Issue1239CoalesceCommonTypeEmittedSessionTests
{
    [Fact]
    public void NumericWidening_RightWidensToLeftUnderlying_LeftPresent()
    {
        var source = """
            let a int32? = 100
            let b uint16 = 7
            Console.WriteLine((a ?? b).ToString())
            """;

        Assert.Equal($"100{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void NumericWidening_RightWidensToLeftUnderlying_LeftNil()
    {
        var source = """
            let a int32? = nil
            let b uint16 = 7
            Console.WriteLine((a ?? b).ToString())
            """;

        Assert.Equal($"7{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void NumericWidening_LeftWidensToRight_LeftPresent_ConvertsToResultType()
    {
        var source = """
            let a int32? = 100
            let b int64 = 9000000000
            Console.WriteLine((a ?? b).ToString())
            """;

        Assert.Equal($"100{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void NumericWidening_LeftWidensToRight_LeftNil()
    {
        var source = """
            let a int32? = nil
            let b int64 = 9000000000
            Console.WriteLine((a ?? b).ToString())
            """;

        Assert.Equal($"9000000000{Environment.NewLine}", RunSubmission(source));
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

        return outWriter.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}

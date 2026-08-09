// <copyright file="Issue1236NullableNumericWideningEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1236: Emitted-session coverage for nullable numeric widening.
/// </summary>
public class Issue1236NullableNumericWideningEmittedSessionTests
{
    [Fact]
    public void LiftedLiteralEquality_Present_IsTrue()
    {
        var source = """
            let v uint8 = 11
            let b uint8? = v
            Console.WriteLine((b == 11).ToString())
            """;

        Assert.Equal($"True{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void LiftedLiteralEquality_Nil_IsFalse()
    {
        var source = """
            let b uint8? = nil
            Console.WriteLine((b == 11).ToString())
            """;

        Assert.Equal($"False{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void LiftedDirectionalWideningEquality_Present_IsTrue()
    {
        var source = """
            let av uint8 = 3
            let a uint8? = av
            let bv int32 = 3
            let b int32? = bv
            Console.WriteLine((a == b).ToString())
            """;

        Assert.Equal($"True{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void LiftedDirectionalWideningEquality_NilOperand_IsFalse()
    {
        var source = """
            let av uint8 = 3
            let a uint8? = av
            let b int32? = nil
            Console.WriteLine((a == b).ToString())
            """;

        Assert.Equal($"False{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void LiftedArithmeticWidening_Present_AddsThroughUnderlying()
    {
        var source = """
            let av int64 = 5
            let a int64? = av
            let bv int32 = 11
            let b int32? = bv
            Console.WriteLine((a + b).ToString())
            """;

        Assert.Equal($"16{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void LiftedArithmeticWidening_NilOperand_PropagatesNull()
    {
        var source = """
            let av int64 = 5
            let a int64? = av
            let b int32? = nil
            Console.WriteLine(((a + b) == nil).ToString())
            """;

        Assert.Equal($"True{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void LiftedLiteralArithmetic_AdaptsLiteralToUnderlying()
    {
        var source = """
            let v int64 = 5
            let b int64? = v
            Console.WriteLine((b + 11).ToString())
            """;

        Assert.Equal($"16{Environment.NewLine}", RunSubmission(source));
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

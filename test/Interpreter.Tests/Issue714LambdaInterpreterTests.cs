// <copyright file="Issue714LambdaInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #714 / ADR-0074 — interpreter parity for the new arrow-lambda
/// expression form and the deprecated switch-arm arrow (GS0302) warning.
/// </summary>
public class Issue714LambdaInterpreterTests
{
    [Fact]
    public void Lambda_TypedParameter_Invokes_AndReturnsValue()
    {
        var source = "let f = (x int32) -> x + 1\nf(41)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Lambda_BlockBody_TrailingExpression_IsResult()
    {
        var source = "let f = (x int32) -> {\n  let y = x * 2\n  y + 2\n}\nf(20)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Lambda_CapturesOuterLocal()
    {
        var source = "let base = 40\nlet f = (x int32) -> x + base\nf(2)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void SwitchExpression_ColonArm_Evaluates_NoWarning()
    {
        var source = "let n = 1\nlet s = switch n {\n  case 0: \"zero\"\n  default: \"other\"\n}\ns";
        var output = RunSubmission(source);
        Assert.Contains("other", output);
        Assert.DoesNotContain("GS0302", output);
    }

    [Fact]
    public void SwitchExpression_ArrowArm_EmitsGs0302_StillEvaluates()
    {
        var source = "let n = 0\nlet s = switch n {\n  case 0 -> \"zero\"\n  default -> \"other\"\n}\ns";
        var output = RunSubmission(source);
        Assert.Contains("zero", output);
        Assert.Contains("GS0302", output);
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

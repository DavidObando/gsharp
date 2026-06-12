// <copyright file="Issue716LambdaBindingInferenceInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #716 / ADR-0076 — interpreter parity for type inference on
/// <c>let</c> / <c>var</c> bindings whose initializer is a lambda with
/// fully typed parameters. The binding's type is inferred to be the
/// lambda's <c>(T1, ...) -&gt; R</c> function type, so the user does not
/// have to repeat the function-type clause.
/// </summary>
public class Issue716LambdaBindingInferenceInterpreterTests
{
    [Fact]
    public void Inferred_SingleParam_Lambda_IsCallable()
    {
        var source = "var square = (n int32) -> n * n\nsquare(7)";
        var output = RunSubmission(source);
        Assert.Contains("49", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Inferred_StringIdentity_Lambda_IsCallable()
    {
        var source = "let id = (s string) -> s\nid(\"hello\")";
        var output = RunSubmission(source);
        Assert.Contains("hello", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Inferred_MultiParam_Lambda_IsCallable()
    {
        var source = "let add = (a int32, b int32) -> a + b\nadd(20, 22)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Inferred_ZeroParam_Lambda_IsCallable()
    {
        var source = "let always = () -> 42\nalways()";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Inferred_BlockBody_Lambda_IsCallable()
    {
        var source = "let inc = (n int32) -> { return n + 1 }\ninc(41)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Inferred_VoidReturning_Lambda_IsCallable()
    {
        var source = "let log = (msg string) -> System.Console.WriteLine(msg)\nlog(\"ok\")";
        var output = RunSubmission(source);
        Assert.Contains("ok", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void Inferred_Lambda_CapturesLocal()
    {
        var source = "let basis = 100\nlet addBase = (n int32) -> n + basis\naddBase(7)";
        var output = RunSubmission(source);
        Assert.Contains("107", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void TargetTyped_Lambda_ParametersCanBeOmitted()
    {
        var source = "let twice (int32) -> int32 = (x) -> x * 2\ntwice(21)";
        var output = RunSubmission(source);
        Assert.Contains("42", output);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void OpenLambdaBinding_ReportsGS0304()
    {
        var source = "let f = (x) -> x + 1\nf(1)";
        var output = RunSubmission(source);
        Assert.Contains("GS0304", output);
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

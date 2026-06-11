// <copyright file="RefLocalAliasingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #491 (ADR-0060 follow-up): interpreter tests for ref-aliasing locals
/// (<c>let ref</c> / <c>var ref</c>). Aliasing must observe writes to the
/// pointee through the alias and vice versa, parallel to the IL emitter's
/// <c>ldloc; ldind</c> / <c>ldloc; stind</c> lowering.
/// </summary>
public class RefLocalAliasingInterpreterTests
{
    [Fact]
    public void LetRef_WriteThroughAlias_UpdatesUnderlyingVariable()
    {
        var output = RunSubmission(@"
func tweak() {
    var n = 10
    let ref m = n
    m = m + 5
    print(string(n))
}
tweak()
");
        Assert.Contains("15", output);
    }

    [Fact]
    public void LetRef_ReadThroughAlias_ObservesUnderlyingMutation()
    {
        var output = RunSubmission(@"
func tweak() {
    var n = 10
    let ref m = n
    n = 42
    print(string(m))
}
tweak()
");
        Assert.Contains("42", output);
    }

    [Fact]
    public void LetRef_WriteThroughAlias_TwoWayObserved()
    {
        var output = RunSubmission(@"
func tweak() {
    var n = 10
    let ref m = n
    m = m * 2
    n = n + 1
    print(string(m))
    print(string(n))
}
tweak()
");
        // m and n must observe the same storage. After m *= 2 → n = 20.
        // After n += 1 → m reads 21.
        Assert.Contains("21", output);
    }

    [Fact]
    public void LetRef_AliasStructField_WritesThrough()
    {
        var output = RunSubmission(@"
type Counter struct {
    var Value int32
}

func tweak() {
    var c = Counter{Value: 1}
    let ref v = c.Value
    v = 7
    print(string(c.Value))
}
tweak()
");
        Assert.Contains("7", output);
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

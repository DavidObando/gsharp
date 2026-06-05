// <copyright file="RefKindInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0060 item #7: interpreter parity for G#-authored functions with
/// <c>ref</c>/<c>out</c>/<c>in</c> parameters. The interpreter must
/// route ref-kind parameter slots through the same write-back path the
/// CLR-method dispatch already uses, so user-defined function bodies
/// observe the caller's value and mutations propagate back.
/// </summary>
public class RefKindInterpreterTests
{
    [Fact]
    public void RefParameter_CallerObservesMutation()
    {
        var output = RunSubmission(@"
func bump(ref counter int32, by int32) {
    counter = counter + by
}

var c = 10
bump(&c, 5)
print(string(c))
");
        Assert.Contains("15", output);
    }

    [Fact]
    public void OutParameter_CallerReceivesAssignedValue()
    {
        var output = RunSubmission(@"
func tryProduce(out result int32) bool {
    result = 42
    return true
}

var v = 0
let ok = tryProduce(&v)
print(string(v))
");
        Assert.Contains("42", output);
    }

    [Fact]
    public void InParameter_BodyReadsCallerValue()
    {
        var output = RunSubmission(@"
func sum(in x int32, in y int32) int32 {
    return x + y
}

var a = 7
var b = 35
print(string(sum(&a, &b)))
");
        Assert.Contains("42", output);
    }

    [Fact]
    public void InParameter_CallerValueIsUnchanged()
    {
        var output = RunSubmission(@"
func observe(in v int32) {
    print(string(v))
}

var x = 12
observe(&x)
print(string(x))
");
        Assert.Contains("12", output);
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

// <copyright file="RefLocalAliasingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Repl.Engine;
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
struct Counter {
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

    [Fact]
    public void LetRef_ArrayIndexRead_CapturesOriginalElement()
    {
        var output = RunSubmission(@"
func probe() {
    var arr = []int32{10, 20, 30}
    var i int32 = 0
    let ref r = arr[i]
    i = 2
    print(string(r))
}
probe()
");
        Assert.Equal($"10{Environment.NewLine}", output);
    }

    [Fact]
    public void LetRef_ArrayIndexWrite_CapturesOriginalElement()
    {
        var output = RunSubmission(@"
func probe() {
    var arr = []int32{10, 20, 30}
    var i int32 = 0
    let ref r = arr[i]
    i = 2
    r = 99
    print(string(arr[0]) + "","" + string(arr[1]) + "","" + string(arr[2]))
}
probe()
");
        Assert.Equal($"99,20,30{Environment.NewLine}", output);
    }

    [Fact]
    public void LetRef_ArrayIndexWithoutIndexMutation_StillReadsAndWritesElement()
    {
        var output = RunSubmission(@"
func probe() {
    var arr = []int32{10, 20, 30}
    var i int32 = 0
    let ref r = arr[i]
    r = 99
    print(string(r) + "","" + string(arr[0]) + "","" + string(arr[1]) + "","" + string(arr[2]))
}
probe()
");
        Assert.Equal($"99,99,20,30{Environment.NewLine}", output);
    }

    [Fact]
    public void LetRef_ClassField_CapturesReceiverBeforeReassignment()
    {
        var output = RunSubmission(@"
class Box {
    var Value int32
}

func probe() {
    var first = Box{Value: 10}
    var current = first
    let ref r = current.Value
    current = Box{Value: 20}
    r = 99
    print(string(r) + ""|"" + string(first.Value) + ""|"" + string(current.Value))
}
probe()
");
        Assert.Equal($"99|99|20{Environment.NewLine}", output);
    }

    [Fact]
    public void LetRef_BlockExpression_EvaluatesPrefixOnceAndCapturesElement()
    {
        var output = RunSubmission(@"
func probe() {
    var original = []int32{10, 20, 30}
    var current = original
    let ref r = current[^1]
    current = []int32{40, 50, 60}
    r = 99
    print(string(r) + ""|"" + string(original[0]) + "","" + string(original[1]) + "","" + string(original[2]) + ""|"" + string(current[0]) + "","" + string(current[1]) + "","" + string(current[2]))
}
probe()
");
        Assert.Equal($"99|10,20,99|40,50,60{Environment.NewLine}", output);
    }

    [Fact]
    public void LetRef_GlobalVariable_RemainsAliasedToGlobalSlot()
    {
        var output = RunSubmission(@"
var value int32 = 10

func probe() {
    let ref r = value
    r = 55
    print(string(r) + ""|"" + string(value))
}
probe()
");
        Assert.StartsWith($"55|55{Environment.NewLine}", output, StringComparison.Ordinal);
    }

    [Fact]
    public void LetRef_UnmanagedPointerDereference_ReportsGs0513()
    {
        const string Source = """
            func probe() {
                unsafe {
                    var p *int32 = nil
                    let ref r = *p
                    print(string(r))
                }
            }
            probe()
            """;

        var cell = new SessionEngine().Evaluate(Source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0513", diagnostic.Id);
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

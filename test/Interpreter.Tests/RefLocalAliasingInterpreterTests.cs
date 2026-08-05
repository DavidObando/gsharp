// <copyright file="RefLocalAliasingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #491 (ADR-0060 follow-up): tests for ref-aliasing locals
/// (<c>let ref</c> / <c>var ref</c>). Aliasing must observe writes to the
/// pointee through the alias and vice versa, via the IL emitter's
/// <c>ldloc; ldind</c> / <c>ldloc; stind</c> lowering. Historically these ran
/// on the tree-walking evaluator; since ADR-0156 Phase 3c (#3176) submissions
/// execute emitted, and the sources swapped the evaluator-only
/// <c>print(string(x))</c> builtins for <c>Console.WriteLine</c> (the
/// <c>print</c>/<c>string(T)</c> builtins have no emitted lowering — issues
/// #3245 and #3246).
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
    Console.WriteLine(n)
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
    Console.WriteLine(m)
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
    Console.WriteLine(m)
    Console.WriteLine(n)
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
    Console.WriteLine(c.Value)
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
    Console.WriteLine(r)
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
    Console.WriteLine(""${arr[0]},${arr[1]},${arr[2]}"")
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
    Console.WriteLine(""${r},${arr[0]},${arr[1]},${arr[2]}"")
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
    Console.WriteLine(""${r}|${first.Value}|${current.Value}"")
}
probe()
");
        Assert.Equal($"99|99|20{Environment.NewLine}", output);
    }

    [Fact(Skip = "Issue #3247: `let ref r = xs[^1]` fails with GS9998 'Cannot take address of expression kind BoundBlockExpression' (the index-from-end lowering wraps the element access in a block). Its only passing coverage was the tree-walking evaluator, retired in ADR-0156 Phase 3c (#3176). Unskip when #3247 lands.")]
    public void LetRef_BlockExpression_EvaluatesPrefixOnceAndCapturesElement()
    {
        var output = RunSubmission(@"
func probe() {
    var original = []int32{10, 20, 30}
    var current = original
    let ref r = current[^1]
    current = []int32{40, 50, 60}
    r = 99
    Console.WriteLine(""${r}|${original[0]},${original[1]},${original[2]}|${current[0]},${current[1]},${current[2]}"")
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
    Console.WriteLine(""${r}|${value}"")
}
probe()
");
        Assert.StartsWith($"55|55{Environment.NewLine}", output, StringComparison.Ordinal);
    }

    [Fact]
    public void LetRef_UnmanagedPointerDereference_RunsEmittedAndSurfacesNilDeref()
    {
        // ADR-0156 Phase 3c (#3176): this test previously pinned GS0513
        // ("pointer operations are not supported in the interpreter") — an
        // evaluator-only diagnostic that retired with the tree-walking engine.
        // Under the emitted engine pointer ref-aliasing compiles and runs; the
        // nil dereference surfaces as a runtime NullReferenceException on the
        // cell (GSI002). The source swaps the interpreter-only
        // `print(string(r))` builtin for Console.WriteLine, which the emitter
        // supports.
        const string Source = """
            import System
            func probe() {
                unsafe {
                    var p *int32 = nil
                    let ref r = *p
                    Console.WriteLine(r)
                }
            }
            probe()
            """;

        using var engine = new EmittedSessionEngine();
        var cell = engine.Evaluate(Source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GSI002", diagnostic.Id);
        Assert.Contains("NullReferenceException", diagnostic.Message);
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

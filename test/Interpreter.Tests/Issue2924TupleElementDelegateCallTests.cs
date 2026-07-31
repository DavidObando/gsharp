// <copyright file="Issue2924TupleElementDelegateCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter parity for issue #2924's shared numeric tuple-selector syntax
/// and binding behavior.
/// </summary>
public class Issue2924TupleElementDelegateCallTests
{
    [Fact]
    public void NumericSelectors_ReadHigherAndNestedElements()
    {
        var output = RunSubmission("""
            let t = ((10, 20), 30)
            let selected = t.0.1
            Console.WriteLine(selected)
            """);

        Assert.Equal("20\n", output);
    }

    [Fact]
    public void NullConditionalNumericSelector_ReadsElement()
    {
        var output = RunSubmission("""
            let t (int32, int32)? = (41, 0)
            let selected = t?.0
            Console.WriteLine(selected)
            """);

        Assert.Equal("41\n", output);
    }

    [Fact]
    public void NumericSelectorValue_FlowsThroughAssignmentAndArgument()
    {
        var output = RunSubmission("""
            func Show(value int32) {
                Console.WriteLine(value)
            }
            let t = (41, 0)
            let selected int32 = t.0
            Show(t.0)
            """);

        Assert.Equal("41\n", output);
    }

    [Fact]
    public void FunctionReturnedTuple_NumericSelectorReadsElement()
    {
        var output = RunSubmission("""
            func Make() (int32, int32) {
                return (41, 0)
            }
            Console.WriteLine(Make().0)
            """);

        Assert.Equal("41\n", output);
    }

    [Fact]
    public void StructTupleField_NumericSelectorReadsElement()
    {
        var output = RunSubmission("""
            data struct Holder(Value (int32, int32))
            let holder = Holder((41, 0))
            Console.WriteLine(holder.Value.0)
            """);

        Assert.Equal("41\n", output);
    }

    [Fact]
    public void CurriedMemberCall_InvokesReceiverWideCallee()
    {
        var output = RunSubmission("""
            class Factory {
                func Make() (int32) -> int32 {
                    return (value int32) -> value + 1
                }
            }
            let factory = Factory()
            Console.WriteLine(factory.Make()(41))
            """);

        Assert.Equal("42\n", output);
    }

    [Fact]
    public void NonCallableTupleElement_ReportsNotAFunction()
    {
        var output = RunSubmission("""
            let t = (41, 0)
            t.0(1)
            """);

        Assert.Contains("GS0131", output);
    }

    [Fact]
    public void NilTupleElementDelegate_ReportsRuntimeFailure()
    {
        var output = RunSubmission("""
            let handler System.Action[int32] = default(System.Action[int32])
            let t = (handler, 0)
            t.0(1)
            """);

        Assert.Contains("error GS", output);
    }

    [Fact]
    public void OutOfRangeNumericSelector_ReportsMissingMember()
    {
        var output = RunSubmission("""
            let t = (41, 0)
            t.2
            """);

        Assert.Contains("GS0158", output);
    }

    [Fact]
    public void ItemNameSelector_RemainsSupported()
    {
        var output = RunSubmission("""
            let t = (41, 0)
            Console.WriteLine(t.Item1)
            """);

        Assert.Equal("41\n", output);
    }

    [Fact]
    public void LeadingDotFloat_RemainsLiteralInPrimaryPosition()
    {
        var output = RunSubmission("Console.WriteLine(.5 + .25)");

        Assert.Equal("0.75\n", output);
    }

    private static string RunSubmission(string text)
    {
        using var output = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(output);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return output.ToString().Replace("\r\n", "\n");
    }
}

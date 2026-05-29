// <copyright file="EventInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0052: interpreter tests for event declarations.
/// </summary>
public class EventInterpreterTests
{
    [Fact]
    public void FieldLikeEvent_ParsesWithoutError()
    {
        var source = "import System\ntype Foo class {\n  public event Click func()\n}\n";
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void FieldLikeEvent_OnClass_WithEventArgs()
    {
        var source = "import System\ntype MyBtn class {\n  public event Click func(Object, EventArgs)\n}\n";
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void MultipleEvents_ParseWithoutError()
    {
        var source = "import System\ntype Foo class {\n  public event A func()\n  public event B func(int32)\n}\n";
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
    }

    [Fact]
    public void InterfaceEvent_ParsesWithoutError()
    {
        var source = "type INotify interface {\n  event Changed func()\n}\n";
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
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

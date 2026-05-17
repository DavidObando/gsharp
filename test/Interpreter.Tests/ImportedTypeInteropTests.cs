// <copyright file="ImportedTypeInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// End-to-end tests that exercise interop with imported .NET types: importing a
/// namespace, calling a static factory method that returns a non-primitive .NET
/// type, calling an instance method on that value, and converting it to string.
/// </summary>
public class ImportedTypeInteropTests
{
    [Fact]
    public void Can_Call_Static_Method_Returning_Imported_Type()
    {
        var output = RunSubmission(
            "import System\n" +
            "var x = Guid.NewGuid()\n" +
            "x\n");
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Unable to find", output);
        // A Guid round-trips through ToString as 32 hex chars with 4 dashes.
        Assert.Matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", output);
    }

    [Fact]
    public void Can_Call_Instance_Method_On_Imported_Type_Value()
    {
        var output = RunSubmission(
            "import System\n" +
            "var x = Guid.NewGuid()\n" +
            "var y = x.ToString()\n" +
            "y\n");
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Unable to find", output);
        Assert.Matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", output);
    }

    [Fact]
    public void Can_Convert_Imported_Type_To_String_Via_Builtin_Cast()
    {
        var output = RunSubmission(
            "import System\n" +
            "var x = Guid.NewGuid()\n" +
            "var y = string(x)\n" +
            "y\n");
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("cannot convert", output, StringComparison.OrdinalIgnoreCase);
        Assert.Matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return outWriter.ToString() + errWriter.ToString();
    }
}

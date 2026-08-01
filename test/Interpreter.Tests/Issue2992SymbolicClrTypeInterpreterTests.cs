// <copyright file="Issue2992SymbolicClrTypeInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter coverage for reifying imported generic types over function type parameters.
/// </summary>
public class Issue2992SymbolicClrTypeInterpreterTests
{
    [Fact]
    public void GenericParameterPositionUsesClosedClrType()
    {
        var source = """
            import System.Collections.Generic

            func First[T](items List[T]) T {
                return items[0]
            }

            var numbers = List[int32]()
            numbers.Add(10)
            Console.WriteLine(First[int32](numbers))
            """;

        Assert.Equal("10\n", RunSubmission(source));
    }

    [Fact]
    public void GenericConstructionAndReturnUseClosedClrType()
    {
        var source = """
            import System.Collections.Generic

            func Make[T]() List[T] {
                return List[T]()
            }

            var numbers = Make[int32]()
            numbers.Add(10)
            Console.WriteLine(numbers[0])
            """;

        Assert.Equal("10\n", RunSubmission(source));
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

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}

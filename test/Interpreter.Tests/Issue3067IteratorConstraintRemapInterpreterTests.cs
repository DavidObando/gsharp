// <copyright file="Issue3067IteratorConstraintRemapInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

[Collection("ConsoleIo")]
public class Issue3067IteratorConstraintRemapInterpreterTests
{
    [Theory]
    [InlineData(false, "66")]
    [InlineData(true, "77")]
    public void ConstraintRepro_TopLevelAndInFunction_Runs(bool inFunction, string expected)
    {
        var source = inFunction ? InFunctionSource : TopLevelSource;
        using var output = new StringWriter();
        var previous = Console.Out;
        Console.SetOut(output);
        try
        {
            var result = new SessionEngine().Evaluate(source);
            Assert.False(result.HasError, string.Join(Environment.NewLine, result.Diagnostics));
        }
        finally
        {
            Console.SetOut(previous);
        }

        Assert.Equal(expected + "\n", output.ToString().Replace("\r\n", "\n"));
    }

    private const string TopLevelSource = """
        package Issue3067.InterpreterTopLevel
        import System
        open class Box[T any] {}
        class IntBox : Box[int32] {}
        func Values[T any, TBox Box[T] init()](value T) sequence[T] {
            yield value
        }
        for value in Values[int32, IntBox](66) {
            Console.WriteLine(value)
        }
        """;

    private const string InFunctionSource = """
        package Issue3067.InterpreterInFunction
        import System
        open class Box[T any] {}
        class IntBox : Box[int32] {}
        func Values[T any, TBox Box[T] init()](value T) sequence[T] {
            yield value
        }
        func Run() {
            for value in Values[int32, IntBox](77) {
                Console.WriteLine(value)
            }
        }
        Run()
        """;
}

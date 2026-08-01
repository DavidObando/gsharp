// <copyright file="Issue2976FunctionLiteralIteratorInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2976: function-literal invocation must classify iterator bodies
/// through the same path as named user functions.
/// </summary>
public sealed class Issue2976FunctionLiteralIteratorInterpreterTests
{
    public static IEnumerable<object[]> Cases()
    {
        yield return Case(
            """
            let values = func() sequence[int32] { yield 2 }
            for value in values() {
                Console.WriteLine(value)
            }
            """,
            "2\n");

        yield return Case(
            """
            func make(start int32) () -> sequence[int32] {
                return func() sequence[int32] {
                    yield start
                    Console.WriteLine(start)
                    yield start + 1
                }
            }

            for value in make(4)() {
                Console.WriteLine(value)
            }
            """,
            "4\n4\n5\n");

        yield return Case(
            """
            func make[T any]() (T) -> sequence[T] {
                return func(value T) sequence[T] { yield value }
            }

            for value in make[string]()("ok") {
                Console.WriteLine(value)
            }
            """,
            "ok\n");

        yield return Case(
            """
            func values() sequence[int32] { yield 9 }
            for value in values() {
                Console.WriteLine(value)
            }
            """,
            "9\n");
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void IteratorLiteral_Runs(string source, string expectedOutput)
    {
        using var writer = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(writer);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(source);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        Assert.Equal(expectedOutput, writer.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
    }

    private static object[] Case(string source, string expectedOutput)
        => new object[] { source, expectedOutput };
}

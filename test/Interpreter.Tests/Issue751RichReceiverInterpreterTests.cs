// <copyright file="Issue751RichReceiverInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Tree-walking interpreter parity for issue #751 / ADR-0084 §L2: the
/// receiver clause now accepts rich type spellings (nullable, tuple,
/// nullable array, map[K]V). Each test exercises the same shape covered
/// by the emit and binder suites but through the REPL evaluator, which
/// shares the binder with the compiler.
/// </summary>
public class Issue751RichReceiverInterpreterTests
{
    [Fact]
    public void NullableString_Receiver_Dispatches()
    {
        var source = """
            func (self string?) OrElse(fb string) string {
                return self ?: fb
            }

            var present string? = "hi"
            var absent string? = nil
            Console.WriteLine(present.OrElse("nope"))
            Console.WriteLine(absent.OrElse("nope"))
            """;

        Assert.Equal("hi\nnope\n", RunSubmission(source));
    }

    [Fact]
    public void Tuple_Receiver_Dispatches()
    {
        var source = """
            func (self (int32, string)) Show() string {
                return self.Item1.ToString() + ":" + self.Item2
            }

            var p = (42, "hi")
            Console.WriteLine(p.Show())
            """;

        Assert.Equal("42:hi\n", RunSubmission(source));
    }

    [Fact]
    public void NullableArray_Receiver_Dispatches()
    {
        var source = """
            func (self []int32?) FirstOrZero() int32 {
                if self == nil {
                    return 0
                }
                if self.Length == 0 {
                    return 0
                }
                return self[0]
            }

            var present []int32? = []int32{10, 20}
            var absent []int32? = nil
            Console.WriteLine(present.FirstOrZero())
            Console.WriteLine(absent.FirstOrZero())
            """;

        Assert.Equal("10\n0\n", RunSubmission(source));
    }

    [Fact]
    public void Map_Receiver_Dispatches()
    {
        var source = """
            func (self map[string]int32) CountKeys() int32 {
                return self.Count
            }

            var m = map[string]int32{"a": 1, "b": 2, "c": 3}
            Console.WriteLine(m.CountKeys())
            """;

        Assert.Equal("3\n", RunSubmission(source));
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

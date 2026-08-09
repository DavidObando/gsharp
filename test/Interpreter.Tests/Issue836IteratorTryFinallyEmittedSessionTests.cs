// <copyright file="Issue836IteratorTryFinallyEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #836: Emitted-session coverage for iterator try finally.
/// </summary>
public class Issue836IteratorTryFinallyEmittedSessionTests
{
    [Fact]
    public void Iterator_TryFinally_FinallyRuns_AllYieldsObserved()
    {
        // Emitted iterator state-machine semantics: each value reaches the
        // consumer in order, then the finally body runs exactly once when
        // enumeration completes.
        var source = """
            import System
            import System.Collections.Generic

            func gen() IEnumerable[int32] {
                try {
                    yield 1
                    yield 2
                } finally {
                    Console.WriteLine("dispose")
                }
            }

            for v in gen() {
                Console.WriteLine(v)
            }
            """;

        var output = RunSubmission(source);
        Assert.Equal(
            "1" + Environment.NewLine + "2" + Environment.NewLine + "dispose" + Environment.NewLine,
            output);
        Assert.Contains("2" + Environment.NewLine, output, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(output, "dispose"));
    }

    [Fact]
    public void Iterator_NestedTryFinally_BothFinalliesRunInOrder()
    {
        var source = """
            import System
            import System.Collections.Generic

            func gen() IEnumerable[int32] {
                try {
                    try {
                        yield 1
                        yield 2
                    } finally {
                        Console.WriteLine("inner")
                    }
                } finally {
                    Console.WriteLine("outer")
                }
            }

            for v in gen() {
                Console.WriteLine(v)
            }
            """;

        var output = RunSubmission(source);
        var idxInner = output.IndexOf("inner", StringComparison.Ordinal);
        var idxOuter = output.IndexOf("outer", StringComparison.Ordinal);
        Assert.True(idxInner >= 0, "inner finally must run");
        Assert.True(idxOuter > idxInner, "outer finally runs after inner finally");
        Assert.Equal(
            "1" + Environment.NewLine +
            "2" + Environment.NewLine +
            "inner" + Environment.NewLine +
            "outer" + Environment.NewLine,
            output);
        Assert.Contains("2" + Environment.NewLine, output, StringComparison.Ordinal);
    }

    [Fact]
    public void Iterator_TryFinally_BodyBetweenYields_RunsOnce()
    {
        var source = """
            import System
            import System.Collections.Generic

            func gen() IEnumerable[int32] {
                try {
                    yield 100
                    Console.WriteLine("mid")
                    yield 200
                } finally {
                    Console.WriteLine("fin")
                }
            }

            for v in gen() {
                Console.WriteLine(v)
            }
            """;

        var output = RunSubmission(source);
        Assert.Equal(
            "100" + Environment.NewLine +
            "mid" + Environment.NewLine +
            "200" + Environment.NewLine +
            "fin" + Environment.NewLine,
            output);
        Assert.Contains("200" + Environment.NewLine, output, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(output, "mid"));
        Assert.Equal(1, CountOccurrences(output, "fin"));
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        if (string.IsNullOrEmpty(needle))
        {
            return 0;
        }

        var count = 0;
        var idx = 0;
        while ((idx = haystack.IndexOf(needle, idx, StringComparison.Ordinal)) >= 0)
        {
            count++;
            idx += needle.Length;
        }

        return count;
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

        return outWriter.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}

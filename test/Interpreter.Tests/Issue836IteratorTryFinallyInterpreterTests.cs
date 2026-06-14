// <copyright file="Issue836IteratorTryFinallyInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #836 — tree-walking interpreter parity for iterator bodies
/// that contain <c>try</c>/<c>finally</c> around <c>yield</c>. The
/// interpreter realizes iterators eagerly (collects all yielded
/// values into a backing list), so the <c>finally</c> simply needs
/// to run when the iterator body completes — but the full body must
/// execute without the interpreter crashing on the protected region.
/// </summary>
public class Issue836IteratorTryFinallyInterpreterTests
{
    [Fact]
    public void Iterator_TryFinally_FinallyRuns_AllYieldsObserved()
    {
        // The tree-walking interpreter realizes iterators eagerly
        // (collects all yields into a backing list, then exposes them
        // to the consumer). Order between the finally and the
        // consumer loop is therefore inverted relative to the
        // state-machine emit semantics — but the contract that holds
        // across both is: every yielded value is observed, and the
        // finally body runs exactly once.
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
        Assert.Contains("1", output);
        Assert.Contains("2", output);
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
        Assert.Contains("1", output);
        Assert.Contains("2", output);
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
        Assert.Contains("100", output);
        Assert.Contains("200", output);
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

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}

// <copyright file="Issue774OpenReceiverIterationEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #774: Emitted-session coverage for open receiver iteration.
/// </summary>
/// <remarks>
/// The Dictionary[K, V] case is intentionally omitted — the
/// emitted session covers the supported closed-instantiation branch of the
/// erased self parameter for Dictionary receivers (documented in
/// <c>Issue773GenericReceiverEmittedSessionTests.DictionaryKV_Receiver_Dispatches</c>),
/// which is independent of the iteration fix here. End-to-end IL
/// coverage for the Dictionary case lives in the emit suite.
/// </remarks>
public class Issue774OpenReceiverIterationEmittedSessionTests
{
    [Fact]
    public void IEnumerableT_Receiver_ForIn_Returns_First_Element_As_T()
    {
        // This emitted-session case uses a reference-typed element; value-type
        // receiver substitution is covered in the IL-verified emit suite.
        var source = """
            import System.Collections.Generic

            func (self IEnumerable[T]) MyFirst[T any](fb T) T {
                for v in self {
                    return v
                }
                return fb
            }

            var arr = []string{"alpha", "beta"}
            Console.WriteLine(arr.MyFirst(""))
            """;

        Assert.Equal($"alpha{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IEnumerableT_Receiver_ForIn_Counts_Elements()
    {
        var source = """
            import System.Collections.Generic

            func (self IEnumerable[T]) MyCount[T](seed T) int32 {
                var n = 0
                for v in self {
                    n = n + 1
                }
                return n
            }

            var arr = []string{"a", "b", "c", "d"}
            Console.WriteLine(arr.MyCount(""))
            """;

        Assert.Equal($"4{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void SequenceT_Receiver_ForIn_Forwards_Element_As_T()
    {
        // See note above: this emitted-session case uses a reference-typed
        // element.
        var source = """
            func passthrough[T](x T) T {
                return x
            }

            func (self sequence[T]) FirstOr[T](fb T) T {
                for v in self {
                    return passthrough(v)
                }
                return fb
            }

            var arr = []string{"x", "y"}
            Console.WriteLine(arr.FirstOr(""))
            """;

        Assert.Equal($"x{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void SliceT_Receiver_ForIn_Returns_First_Element()
    {
        var source = """
            func (self []T) Head[T](fb T) T {
                for v in self {
                    return v
                }
                return fb
            }

            var arr = []int32{7, 8, 9}
            Console.WriteLine(arr.Head(0))
            """;

        Assert.Equal($"7{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void IEnumerableT_Receiver_ForIn_Roundtrips_StringElement()
    {
        var source = """
            import System.Collections.Generic

            func (self IEnumerable[T]) MyFirst[T](fb T) T {
                for v in self {
                    return v
                }
                return fb
            }

            var arr = []string{"hello", "world"}
            Console.WriteLine(arr.MyFirst(""))
            """;

        Assert.Equal($"hello{Environment.NewLine}", RunSubmission(source));
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

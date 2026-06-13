// <copyright file="Issue774OpenReceiverIterationInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Tree-walking interpreter parity for issue #774: iterating an open
/// generic receiver (`IEnumerable[T]`, `sequence[T]`, `[]T`) via
/// `for v in self` must bind `v` as the open element type `T` (not
/// `object`) so a `return v` typed as `T` succeeds at run time too.
/// </summary>
/// <remarks>
/// The Dictionary[K, V] case is intentionally omitted — the
/// tree-walking interpreter has a pre-existing limitation with the
/// erased self parameter for Dictionary receivers (documented in
/// <c>Issue773GenericReceiverInterpreterTests.DictionaryKV_Receiver_Dispatches</c>),
/// which is independent of the iteration fix here. End-to-end IL
/// coverage for the Dictionary case lives in the emit suite.
/// </remarks>
public class Issue774OpenReceiverIterationInterpreterTests
{
    [Fact]
    public void IEnumerableT_Receiver_ForIn_Returns_First_Element_As_T()
    {
        // Note: the tree-walking interpreter shares the receiver-substitution
        // limitation from #773 that surfaces when the inferred T closes to
        // a value type. We use a reference-typed element here to keep the
        // interpreter path on the supported branch; value-type element
        // coverage lives in the IL-verified emit suite.
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

        Assert.Equal("alpha\n", RunSubmission(source));
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

        Assert.Equal("4\n", RunSubmission(source));
    }

    [Fact]
    public void SequenceT_Receiver_ForIn_Forwards_Element_As_T()
    {
        // See note above: reference-typed element keeps the interpreter
        // path on the supported branch.
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

        Assert.Equal("x\n", RunSubmission(source));
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

        Assert.Equal("7\n", RunSubmission(source));
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

        Assert.Equal("hello\n", RunSubmission(source));
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

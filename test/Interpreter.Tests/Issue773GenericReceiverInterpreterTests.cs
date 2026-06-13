// <copyright file="Issue773GenericReceiverInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Tree-walking interpreter parity for issue #773: dispatch through an
/// extension whose receiver type carries a function-level type
/// parameter must succeed in the REPL evaluator too, not only via the
/// compiled / IL-verified path.
/// </summary>
public class Issue773GenericReceiverInterpreterTests
{
    [Fact]
    public void IEnumerableT_Repro_From_Issue_Dispatches()
    {
        var source = """
            import System.Collections.Generic

            func (self IEnumerable[T]) MyFirst[T any](fb T) T {
                return fb
            }

            var arr = []int32{10, 20, 30}
            Console.WriteLine(arr.MyFirst(99))
            """;

        Assert.Equal("99\n", RunSubmission(source));
    }

    [Fact]
    public void SequenceT_HeadOr_Dispatches_Int32Slice()
    {
        var source = """
            func (self sequence[T]) HeadOr[T](fb T) T {
                return fb
            }

            var arr = []int32{1, 2, 3}
            Console.WriteLine(arr.HeadOr(7))
            """;

        Assert.Equal("7\n", RunSubmission(source));
    }

    [Fact]
    public void SequenceT_HeadOr_Dispatches_StringSlice()
    {
        var source = """
            func (self sequence[T]) HeadOr[T](fb T) T {
                return fb
            }

            var arr = []string{"a", "b"}
            Console.WriteLine(arr.HeadOr("z"))
            """;

        Assert.Equal("z\n", RunSubmission(source));
    }

    [Fact]
    public void NullableReceiver_StringNullable_Dispatches()
    {
        var source = """
            func (self T?) MyOrElse[T](fb T) T {
                if self != nil { return self!! }
                return fb
            }

            var s string? = nil
            Console.WriteLine(s.MyOrElse("def"))
            """;

        Assert.Equal("def\n", RunSubmission(source));
    }

    [Fact]
    public void NullableReceiver_Int32Nullable_Dispatches()
    {
        var source = """
            func (self T?) MyOrElse[T](fb T) T {
                if self != nil { return self!! }
                return fb
            }

            var v int32? = nil
            Console.WriteLine(v.MyOrElse(99))
            """;

        Assert.Equal("99\n", RunSubmission(source));
    }

    [Fact]
    public void DictionaryKV_Receiver_Dispatches()
    {
        var source = """
            import System.Collections.Generic

            func (self Dictionary[K, V]) MyCount[K, V]() int32 {
                return 42
            }

            var d = Dictionary[string, int32]()
            Console.WriteLine(d.MyCount())
            """;

        Assert.Equal("42\n", RunSubmission(source));
    }

    [Fact]
    public void SliceT_Receiver_Dispatches()
    {
        var source = """
            func (self []T) FirstOr[T](fb T) T {
                return fb
            }

            var a = []int32{1, 2, 3}
            Console.WriteLine(a.FirstOr(99))
            """;

        Assert.Equal("99\n", RunSubmission(source));
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

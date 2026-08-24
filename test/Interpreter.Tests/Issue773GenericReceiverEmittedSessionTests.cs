// <copyright file="Issue773GenericReceiverEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #773: Emitted-session coverage for generic receiver.
/// </summary>
public class Issue773GenericReceiverEmittedSessionTests
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

        Assert.Equal($"99{Environment.NewLine}", RunSubmission(source));
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

        Assert.Equal($"7{Environment.NewLine}", RunSubmission(source));
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

        Assert.Equal($"z{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void NullableReceiver_StringNullable_Dispatches()
    {
        var source = """
            func (self T?) MyOrElse[T](fb T) T {
                if self != nil { return self }
                return fb
            }

            var s string? = nil
            Console.WriteLine(s.MyOrElse("def"))
            """;

        Assert.Equal($"def{Environment.NewLine}", RunSubmission(source));
    }

    [Fact]
    public void NullableReceiver_Int32Nullable_Dispatches()
    {
        var source = """
            func (self T?) MyOrElse[T](fb T) T {
                if self != nil { return self }
                return fb
            }

            var v int32? = nil
            Console.WriteLine(v.MyOrElse(99))
            """;

        Assert.Equal($"99{Environment.NewLine}", RunSubmission(source));
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

        Assert.Equal($"42{Environment.NewLine}", RunSubmission(source));
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

        Assert.Equal($"99{Environment.NewLine}", RunSubmission(source));
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

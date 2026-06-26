// <copyright file="Issue710NullConditionalIndexingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #710 / ADR-0073 — interpreter parity for the new <c>a?[i]</c>
/// null-conditional indexing operator. The binder reuses
/// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundNullConditionalAccessExpression"/>
/// with the index sub-expression as the <c>WhenNotNull</c> body, so the
/// evaluator accepts <c>?[]</c> without any new node kind. These tests
/// mirror the emit suite shape-for-shape.
/// </summary>
public class Issue710NullConditionalIndexingInterpreterTests
{
    [Fact]
    public void Slice_NullReceiver_YieldsNil()
    {
        var source = """
            var a ([]int32)? = nil
            var x = a?[0]
            if x == nil {
                Console.WriteLine("nil")
            } else {
                Console.WriteLine("notnil")
            }
            """;
        var output = RunSubmission(source);
        Assert.Contains("nil", output);
        Assert.DoesNotContain("notnil", output);
    }

    [Fact]
    public void Slice_NonNullReceiver_YieldsLiftedValue()
    {
        var source = """
            var a ([]int32)? = []int32{10, 20, 30}
            var x = a?[1]
            Console.WriteLine(x)
            """;
        var output = RunSubmission(source);
        Assert.Contains("20", output);
    }

    [Fact]
    public void Map_NullReceiver_YieldsNil()
    {
        var source = """
            var d Dictionary[string, int32]? = nil
            var v = d?["k"]
            if v == nil {
                Console.WriteLine("nil")
            } else {
                Console.WriteLine("notnil")
            }
            """;
        var output = RunSubmission(source);
        Assert.Contains("nil", output);
        Assert.DoesNotContain("notnil", output);
    }

    [Fact]
    public void Map_NonNullReceiver_YieldsLiftedValue()
    {
        var source = """
            var d Dictionary[string, int32]? = Dictionary[string, int32]()
            d.Add("a", 100)
            d.Add("b", 200)
            var v = d?["a"]
            Console.WriteLine(v)
            """;
        var output = RunSubmission(source);
        Assert.Contains("100", output);
    }

    [Fact]
    public void StringDictionary_ReferenceTypedResult_PropagatesNil()
    {
        var source = """
            var d Dictionary[string, string]? = Dictionary[string, string]()
            d.Add("hi", "world")
            Console.WriteLine(d?["hi"])

            var d2 Dictionary[string, string]? = nil
            var v = d2?["hi"]
            if v == nil {
                Console.WriteLine("nil")
            }
            """;
        var output = RunSubmission(source);
        Assert.Contains("world", output);
        Assert.Contains("nil", output);
    }

    [Fact]
    public void Receiver_EvaluatedOnce_WhenNonNull()
    {
        // The receiver function is called once per `?[...]` site whether
        // or not it returns nil. The index sub-expression must not be
        // evaluated when the receiver is nil.
        var source = """
            var receiverCalls int32 = 0
            var indexCalls int32 = 0

            func getSlice() ([]int32)? {
                receiverCalls = receiverCalls + 1
                return []int32{7, 8, 9}
            }

            func getNilSlice() ([]int32)? {
                receiverCalls = receiverCalls + 1
                return nil
            }

            func getIndex() int32 {
                indexCalls = indexCalls + 1
                return 1
            }

            func main() {
                var x = getSlice()?[getIndex()]
                Console.WriteLine(x)
                Console.WriteLine(receiverCalls)
                Console.WriteLine(indexCalls)

                var y = getNilSlice()?[getIndex()]
                if y == nil {
                    Console.WriteLine("nil")
                }
                Console.WriteLine(receiverCalls)
                Console.WriteLine(indexCalls)
            }

            main()
            """;
        var output = RunSubmission(source).Replace("\r\n", "\n");
        var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("8", lines[0]);
        Assert.Equal("1", lines[1]);
        Assert.Equal("1", lines[2]);
        Assert.Equal("nil", lines[3]);
        Assert.Equal("2", lines[4]);
        Assert.Equal("1", lines[5]);
    }

    [Fact]
    public void Chained_NullConditional_Member_Then_Index()
    {
        var source = """
            class Holder {
                var Data ([]int32)?
            }

            func main() {
                var h Holder? = Holder{Data: []int32{1, 2, 3}}
                var v = h?.Data?[1]
                Console.WriteLine(v)

                var hNoData Holder? = Holder{Data: nil}
                var v2 = hNoData?.Data?[0]
                if v2 == nil {
                    Console.WriteLine("nil-data")
                }

                var hNil Holder? = nil
                var v3 = hNil?.Data?[0]
                if v3 == nil {
                    Console.WriteLine("nil-holder")
                }
            }

            main()
            """;
        var output = RunSubmission(source);
        Assert.Contains("2", output);
        Assert.Contains("nil-data", output);
        Assert.Contains("nil-holder", output);
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

        return outWriter.ToString();
    }
}

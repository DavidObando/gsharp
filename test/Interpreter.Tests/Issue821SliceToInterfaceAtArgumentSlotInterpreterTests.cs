// <copyright file="Issue821SliceToInterfaceAtArgumentSlotInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #821 — tree-walking interpreter parity for the slice-to-interface
/// implicit conversion applied at ordinary argument slots. Mirrors the
/// emit suite (<c>Issue821SliceToInterfaceAtArgumentSlotEmitTests</c>)
/// at the closed instantiation level; covers static-method (shared) and
/// free-function call sites where the parameter is typed as
/// <c>IEnumerable[T]</c>, <c>IList[T]</c>, <c>ICollection[T]</c>, or
/// <c>IReadOnlyList[T]</c>.
/// </summary>
public class Issue821SliceToInterfaceAtArgumentSlotInterpreterTests
{
    [Fact]
    public void StaticGeneric_IEnumerableOfT_AcceptsSliceLiteral_Int32()
    {
        // The literal issue repro at the static-call argument slot.
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
                        var index = 0
                        for v in source {
                            yield (index, v)
                            index = index + 1
                        }
                    }
                }
            }

            var sumIdx = 0
            var sumVal = 0
            for p in Sequences.Indexed[int32]([]int32{10, 20, 30}) {
                sumIdx = sumIdx + p.Item1
                sumVal = sumVal + p.Item2
            }
            Console.WriteLine(sumIdx)
            Console.WriteLine(sumVal)
            """;

        Assert.Equal("3\n60\n", RunSubmission(source));
    }

    [Fact]
    public void StaticGeneric_IEnumerableOfT_AcceptsSliceLiteral_String()
    {
        // String closure of the same shape.
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
                        var index = 0
                        for v in source {
                            yield (index, v)
                            index = index + 1
                        }
                    }
                }
            }

            var sumIdx = 0
            var concat = ""
            for p in Sequences.Indexed[string]([]string{"a", "b", "c"}) {
                sumIdx = sumIdx + p.Item1
                concat = concat + p.Item2
            }
            Console.WriteLine(sumIdx)
            Console.WriteLine(concat)
            """;

        Assert.Equal("3\nabc\n", RunSubmission(source));
    }

    [Fact]
    public void FreeFunctionArgSlot_IEnumerableOfT_AcceptsSliceLiteral()
    {
        // Free-function call slot.
        var source = """
            import System.Collections.Generic

            func Count[T](source IEnumerable[T]) int32 {
                var n = 0
                for _ in source {
                    n = n + 1
                }
                return n
            }

            Console.WriteLine(Count[int32]([]int32{10, 20, 30}))
            """;

        Assert.Equal("3\n", RunSubmission(source));
    }

    [Fact]
    public void StaticGeneric_IListOfT_AcceptsSliceLiteral()
    {
        // `IList[T]` parameter — slice satisfies via backing CLR array.
        var source = """
            import System.Collections.Generic

            class Sink {
                shared {
                    func Take[T](source IList[T]) int32 { return source.Count }
                }
            }

            Console.WriteLine(Sink.Take[int32]([]int32{1, 2, 3}))
            """;

        Assert.Equal("3\n", RunSubmission(source));
    }

    [Fact]
    public void StaticGeneric_ICollectionOfT_AcceptsSliceLiteral()
    {
        // `ICollection[T]` parameter.
        var source = """
            import System.Collections.Generic

            class Sink {
                shared {
                    func Take[T](source ICollection[T]) int32 { return source.Count }
                }
            }

            Console.WriteLine(Sink.Take[int32]([]int32{1, 2, 3, 4}))
            """;

        Assert.Equal("4\n", RunSubmission(source));
    }

    [Fact]
    public void StaticGeneric_IReadOnlyListOfT_AcceptsSliceLiteral()
    {
        // `IReadOnlyList[T]` parameter — slice satisfies via backing CLR
        // array. Returns `int32` to stay on the conversion path.
        var source = """
            import System.Collections.Generic

            class Sink {
                shared {
                    func Take[T](source IReadOnlyList[T]) int32 { return source.Count }
                }
            }

            Console.WriteLine(Sink.Take[int32]([]int32{7, 8, 9}))
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

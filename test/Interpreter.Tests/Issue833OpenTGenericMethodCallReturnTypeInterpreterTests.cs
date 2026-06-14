// <copyright file="Issue833OpenTGenericMethodCallReturnTypeInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Tree-walking interpreter parity for issue #833: open-T generic
/// method calls (e.g. <c>Enumerable.Empty[T]()</c>,
/// <c>Array.Empty[T]()</c>, <c>[]T{}.ToArray()</c>) must also bind
/// and execute correctly in the REPL, not only in the IL-emit path.
/// </summary>
public class Issue833OpenTGenericMethodCallReturnTypeInterpreterTests
{
    [Fact]
    public void EnumerableEmpty_With_OpenT_Roundtrips_Int32()
    {
        var source = """
            import System.Linq
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Empty[T]() IEnumerable[T] {
                        return Enumerable.Empty[T]()
                    }
                }
            }

            var seq = Sequences.Empty[int32]()
            var count = 0
            for v in seq {
                count = count + 1
            }
            Console.WriteLine(count)
            Console.WriteLine("done")
            """;

        Assert.Equal("0\ndone\n", RunSubmission(source));
    }

    [Fact]
    public void EnumerableEmpty_With_OpenT_TopLevelFunc_Roundtrips_String()
    {
        var source = """
            import System.Linq
            import System.Collections.Generic

            func Empty[T]() IEnumerable[T] {
                return Enumerable.Empty[T]()
            }

            var seq = Empty[string]()
            var count = 0
            for v in seq {
                count = count + 1
            }
            Console.WriteLine(count)
            """;

        Assert.Equal("0\n", RunSubmission(source));
    }

    [Fact]
    public void ArrayEmpty_With_OpenT_Returns_SliceOfT()
    {
        var source = """
            class Sequences {
                shared {
                    func Empty[T]() []T {
                        return Array.Empty[T]()
                    }
                }
            }

            var arr = Sequences.Empty[int32]()
            Console.WriteLine(arr.Length)
            """;

        Assert.Equal("0\n", RunSubmission(source));
    }

    [Fact]
    public void ToArray_On_OpenT_Slice_Returns_SliceOfT()
    {
        var source = """
            import System.Linq

            func MakeEmpty[T]() []T {
                return []T{}.ToArray()
            }

            var arr = MakeEmpty[int32]()
            Console.WriteLine(arr.Length)
            var arrS = MakeEmpty[string]()
            Console.WriteLine(arrS.Length)
            """;

        Assert.Equal("0\n0\n", RunSubmission(source));
    }

    [Fact]
    public void EnumerableRepeat_With_OpenT_Roundtrips_Value()
    {
        var source = """
            import System.Linq
            import System.Collections.Generic

            func Repeat[T](v T, n int32) IEnumerable[T] {
                return Enumerable.Repeat[T](v, n)
            }

            var seq = Repeat[int32](42, 3)
            for v in seq {
                Console.WriteLine(v)
            }
            """;

        Assert.Equal("42\n42\n42\n", RunSubmission(source));
    }

    [Fact]
    public void EnumerableEmpty_Inside_Generic_Extension_Method_Roundtrips()
    {
        var source = """
            import System.Linq
            import System.Collections.Generic

            func (self []T) ReplaceWithEmpty[T]() IEnumerable[T] {
                return Enumerable.Empty[T]()
            }

            var arr = []int32{1, 2, 3}
            var seq = arr.ReplaceWithEmpty()
            var count = 0
            for v in seq {
                count = count + 1
            }
            Console.WriteLine(count)
            """;

        Assert.Equal("0\n", RunSubmission(source));
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

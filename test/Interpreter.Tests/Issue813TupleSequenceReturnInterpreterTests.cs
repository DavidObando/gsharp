// <copyright file="Issue813TupleSequenceReturnInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #813 / ADR-0084 §L5 — tree-walking interpreter parity for
/// the value-tuple-element iterator path. Mirrors the emit suite
/// (<c>Issue813TupleSequenceReturnEmitTests</c>) at the closed
/// instantiation level: the open-T form binds cleanly post-fix (see
/// the binder tests) but the tree-walking interpreter has no
/// state-machine substitution for an open generic method-type
/// parameter — same scope split as <c>Issue798</c>.
/// </summary>
public class Issue813TupleSequenceReturnInterpreterTests
{
    [Fact]
    public void SharedStatic_SequenceTupleIntInt_Iterator_Runs()
    {
        // Closed instantiation of the `Indexed` shape from the issue.
        // `yield (a, b)` lands as a yield-statement and executes
        // through the interpreter's iterator path.
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed() sequence[(int32, int32)] {
                        var index = 0
                        for v in []int32{10, 20, 30} {
                            yield (index, v)
                            index = index + 1
                        }
                    }
                }
            }

            var sumIdx = 0
            var sumVal = 0
            for p in Sequences.Indexed() {
                sumIdx = sumIdx + p.Item1
                sumVal = sumVal + p.Item2
            }
            Console.WriteLine(sumIdx)
            Console.WriteLine(sumVal)
            """;

        Assert.Equal("3\n60\n", RunSubmission(source));
    }

    [Fact]
    public void SharedStatic_IEnumerableTupleIntString_Iterator_Runs()
    {
        // Confirms the `IEnumerable[(int32, string)]` spelling
        // dispatches identically.
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Indexed(a string, b string, c string) IEnumerable[(int32, string)] {
                        yield (0, a)
                        yield (1, b)
                        yield (2, c)
                    }
                }
            }

            var sumIdx = 0
            var concat = ""
            for p in Sequences.Indexed("a", "b", "c") {
                sumIdx = sumIdx + p.Item1
                concat = concat + p.Item2
            }
            Console.WriteLine(sumIdx)
            Console.WriteLine(concat)
            """;

        Assert.Equal("3\nabc\n", RunSubmission(source));
    }

    [Fact]
    public void SharedStatic_SequenceTupleStringString_Pairwise_Runs()
    {
        // `Pairwise` over a closed string sequence yields tuples
        // where both element types coincide.
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Pairwise(a string, b string, c string) sequence[(string, string)] {
                        yield (a, b)
                        yield (b, c)
                    }
                }
            }

            var concatFirst = ""
            var concatSecond = ""
            for p in Sequences.Pairwise("a", "b", "c") {
                concatFirst = concatFirst + p.Item1
                concatSecond = concatSecond + p.Item2
            }
            Console.WriteLine(concatFirst)
            Console.WriteLine(concatSecond)
            """;

        Assert.Equal("ab\nbc\n", RunSubmission(source));
    }

    [Fact]
    public void SharedStatic_SequenceThreeTuple_Iterator_Runs()
    {
        // 3-arity tuple element type — exercises the recursive walk
        // over `ElementTypes` past the binary case.
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Triples() sequence[(int32, int32, int32)] {
                        yield (0, 10, 100)
                        yield (1, 11, 101)
                        yield (2, 12, 102)
                    }
                }
            }

            var sum1 = 0
            var sum2 = 0
            var sum3 = 0
            for t in Sequences.Triples() {
                sum1 = sum1 + t.Item1
                sum2 = sum2 + t.Item2
                sum3 = sum3 + t.Item3
            }
            Console.WriteLine(sum1)
            Console.WriteLine(sum2)
            Console.WriteLine(sum3)
            """;

        Assert.Equal("3\n33\n303\n", RunSubmission(source));
    }

    [Fact]
    public void SharedStatic_NestedTuple_Iterator_Runs()
    {
        // Nested tuple `(int32, (int32, int32))` — verifies the
        // interpreter walks both the outer tuple and the inner
        // tuple element types.
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func Nested() sequence[(int32, (int32, int32))] {
                        yield (0, (10, 100))
                        yield (1, (11, 101))
                        yield (2, (12, 102))
                    }
                }
            }

            var sumOuter = 0
            var sumInner1 = 0
            var sumInner2 = 0
            for t in Sequences.Nested() {
                sumOuter = sumOuter + t.Item1
                var inner = t.Item2
                sumInner1 = sumInner1 + inner.Item1
                sumInner2 = sumInner2 + inner.Item2
            }
            Console.WriteLine(sumOuter)
            Console.WriteLine(sumInner1)
            Console.WriteLine(sumInner2)
            """;

        Assert.Equal("3\n33\n303\n", RunSubmission(source));
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

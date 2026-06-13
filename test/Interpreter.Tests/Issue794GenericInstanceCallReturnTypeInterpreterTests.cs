// <copyright file="Issue794GenericInstanceCallReturnTypeInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Tree-walking interpreter parity for issue #794: instance-call and
/// property-access return-type substitution through an open generic
/// receiver must also work in the REPL, not only in the IL-emit path.
/// </summary>
public class Issue794GenericInstanceCallReturnTypeInterpreterTests
{
    [Fact]
    public void ListT_ToArray_From_Generic_Shared_Roundtrips_Int32()
    {
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func MakeList[T any](v T) []T {
                        var list = List[T]()
                        list.Add(v)
                        list.Add(v)
                        return list.ToArray()
                    }
                }
            }

            var arr = Sequences.MakeList[int32](42)
            Console.WriteLine(arr.Length)
            Console.WriteLine(arr[0])
            Console.WriteLine(arr[1])
            """;

        Assert.Equal("2\n42\n42\n", RunSubmission(source));
    }

    [Fact]
    public void ListT_ToArray_From_Generic_Shared_Roundtrips_String()
    {
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func MakeList[T any](v T) []T {
                        var list = List[T]()
                        list.Add(v)
                        return list.ToArray()
                    }
                }
            }

            var arr = Sequences.MakeList[string]("hi")
            Console.WriteLine(arr.Length)
            Console.WriteLine(arr[0])
            """;

        Assert.Equal("1\nhi\n", RunSubmission(source));
    }

    [Fact]
    public void ListT_Count_From_Generic_Shared_Returns_Int32()
    {
        var source = """
            import System.Collections.Generic

            class Sequences {
                shared {
                    func CountThree[T any](v T) int32 {
                        var list = List[T]()
                        list.Add(v)
                        list.Add(v)
                        list.Add(v)
                        return list.Count
                    }
                }
            }

            Console.WriteLine(Sequences.CountThree[int32](0))
            Console.WriteLine(Sequences.CountThree[string](""))
            """;

        Assert.Equal("3\n3\n", RunSubmission(source));
    }

    [Fact]
    public void ListT_Add_With_TypeParameter_Argument_Inside_Generic_TopLevel_Func()
    {
        var source = """
            import System.Collections.Generic

            func MakeAndCount[T any](a T, b T) int32 {
                var list = List[T]()
                list.Add(a)
                list.Add(b)
                return list.Count
            }

            Console.WriteLine(MakeAndCount[int32](1, 2))
            Console.WriteLine(MakeAndCount[string]("x", "y"))
            """;

        Assert.Equal("2\n2\n", RunSubmission(source));
    }

    [Fact]
    public void DictionaryKV_Keys_Iterated_Returns_K()
    {
        var source = """
            import System.Collections.Generic

            class Helper {
                shared {
                    func FirstOrFallback[K any, V any](fb K, seed V) K {
                        var dict = Dictionary[K, V]()
                        dict.Add(fb, seed)
                        for k in dict.Keys {
                            return k
                        }
                        return fb
                    }
                }
            }

            Console.WriteLine(Helper.FirstOrFallback[string, int32]("fallback", 0))
            Console.WriteLine(Helper.FirstOrFallback[int32, string](-1, ""))
            """;

        Assert.Equal("fallback\n-1\n", RunSubmission(source));
    }

    [Fact]
    public void Generic_Extension_Method_With_ListT_ToArray_Roundtrip()
    {
        var source = """
            import System.Collections.Generic

            func (self []T) DoubleViaList[T]() []T {
                var list = List[T]()
                for v in self {
                    list.Add(v)
                    list.Add(v)
                }
                return list.ToArray()
            }

            var arr = []int32{1, 2}
            var doubled = arr.DoubleViaList()
            Console.WriteLine(doubled.Length)
            Console.WriteLine(doubled[0])
            Console.WriteLine(doubled[3])
            """;

        Assert.Equal("4\n1\n2\n", RunSubmission(source));
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

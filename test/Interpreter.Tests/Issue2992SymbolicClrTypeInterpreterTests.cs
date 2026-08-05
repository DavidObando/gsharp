// <copyright file="Issue2992SymbolicClrTypeInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Interpreter coverage for reifying imported generic types over function type parameters.
/// </summary>
public class Issue2992SymbolicClrTypeInterpreterTests
{
    [Fact]
    public void StaticClrCallUsesClosedContainer()
    {
        var source = """
            import GSharp.Interpreter.Tests.ProbeRef

            func Marker[T]() int32 {
                return GenericStaticSlot[T].GetMarker()
            }

            Console.WriteLine(Marker[int32]())
            """;

        Assert.Equal("11\n", RunSubmission(source));
    }

    [Fact]
    public void StaticPropertyReadUsesClosedContainer()
    {
        var source = """
            import System.Collections.Generic

            func ComparerName[T]() string {
                return Comparer[T].Default.GetType().Name
            }

            Console.WriteLine(ComparerName[int32]())
            """;

        Assert.Equal("GenericComparer`1\n", RunSubmission(source));
    }

    [Fact]
    public void ConstructorUsesClosedClrType()
    {
        var source = """
            import System.Collections.Generic

            func Make[T]() List[T] {
                return List[T]()
            }

            var numbers = Make[int32]()
            numbers.Add(33)
            Console.WriteLine(numbers[0])
            """;

        Assert.Equal("33\n", RunSubmission(source));
    }

    [Fact]
    public void PropertyReadUsesClosedReceiver()
    {
        var source = """
            import System.Collections.Generic

            func CapacityOf[T](items List[T]) int32 {
                return items.Capacity
            }

            var numbers = List[int32](44)
            Console.WriteLine(CapacityOf[int32](numbers))
            """;

        Assert.Equal("44\n", RunSubmission(source));
    }

    [Fact]
    public void PropertyWriteUsesClosedReceiver()
    {
        var source = """
            import System.Collections.Generic

            func SetCapacity[T](items List[T]) {
                items.Capacity = 55
            }

            var numbers = List[int32]()
            SetCapacity[int32](numbers)
            Console.WriteLine(numbers.Capacity)
            """;

        Assert.Equal("55\n", RunSubmission(source));
    }

    [Fact]
    public void IndexReadUsesClosedReceiver()
    {
        var source = """
            import System.Collections.Generic

            func First[T](items List[T]) T {
                return items[0]
            }

            var numbers = List[int32]()
            numbers.Add(66)
            Console.WriteLine(First[int32](numbers))
            """;

        Assert.Equal("66\n", RunSubmission(source));
    }

    [Fact]
    public void IndexWriteUsesClosedReceiver()
    {
        var source = """
            import System.Collections.Generic

            func SetFirst[T](items List[T], value T) {
                items[0] = value
            }

            var numbers = List[int32]()
            numbers.Add(1)
            SetFirst[int32](numbers, 77)
            Console.WriteLine(numbers[0])
            """;

        Assert.Equal("77\n", RunSubmission(source));
    }

    [Fact]
    public void ClassTypeParameterUsesClosedReceiver()
    {
        var source = """
            import System.Collections.Generic

            class Holder[T any] {
                func CountOf(items List[T]) int32 {
                    return items.Count
                }
            }

            var holder = Holder[int32]()
            var numbers = List[int32]()
            numbers.Add(1)
            numbers.Add(88)
            Console.WriteLine(holder.CountOf(numbers))
            """;

        Assert.Equal("2\n", RunSubmission(source));
    }

    [Fact]
    public void StaticClassTypeParameterUsesClosedContainer()
    {
        var source = """
            import System.Collections.Generic

            class Holder[T any] {
                shared {
                    func CountOf(items List[T]) int32 {
                        return items.Count
                    }
                }
            }

            var numbers = List[int32]()
            numbers.Add(1)
            numbers.Add(2)
            numbers.Add(3)
            numbers.Add(4)
            Console.WriteLine(Holder[int32].CountOf(numbers))
            """;

        Assert.Equal("4\n", RunSubmission(source));
    }

    [Fact]
    public void DeferredClosureRetainsTypeArguments()
    {
        var source = """
            import System.Collections.Generic

            func MakeCounter[T]() (List[T]) -> int32 {
                return func(items List[T]) int32 {
                    return items.Count
                }
            }

            var counter = MakeCounter[int32]()
            var numbers = List[int32]()
            numbers.Add(1)
            numbers.Add(99)
            Console.WriteLine(counter(numbers))
            """;

        Assert.Equal("2\n", RunSubmission(source));
    }

    [Fact(Skip = "Issue #3248: a method group over an open-generic receiver method deferred through a generic function emits bad IL (BadImageFormatException at runtime). Its only passing coverage was the tree-walking evaluator, retired in ADR-0156 Phase 3c (#3176). Unskip when #3248 lands.")]
    public void DeferredMethodGroupRetainsClassTypeArguments()
    {
        var source = """
            import System.Collections.Generic

            class Holder[T any] {
                func Count(items List[T]) int32 {
                    return items.Count
                }
            }

            func GetCounter[T](holder Holder[T]) (List[T]) -> int32 {
                return holder.Count
            }

            var holder = Holder[int32]()
            var counter = GetCounter[int32](holder)
            var numbers = List[int32]()
            numbers.Add(1)
            numbers.Add(2)
            numbers.Add(3)
            Console.WriteLine(counter(numbers))
            """;

        Assert.Equal("3\n", RunSubmission(source));
    }

    [Fact]
    public void StaticPropertyWriteUsesClosedContainer()
    {
        var source = """
            import GSharp.Interpreter.Tests.ProbeRef

            func Marker() int32 {
                return 111
            }

            func SetValue[T]() {
                GenericStaticSlot[T].Value = Marker()
            }

            SetValue[int32]()
            Console.WriteLine(GenericStaticSlot[int32].Value)
            """;

        Assert.Equal("111\n", RunSubmission(source));
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

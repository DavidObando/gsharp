// <copyright file="Issue4219GenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

public class Issue4219GenericLocalRecursionTests
{
    [Theory]
    [InlineData("first[int32](42, 4)", 42)]
    [InlineData("second(17, 5)", 17)]
    public void TwoMembers_ExplicitAndInferredCalls(string call, int expected)
    {
        var result = EmittedOracle.Evaluate("""
            let first[T] = func(value T, n int32) T {
                if n == 0 { return value }
                return second(value, n - 1)
            }
            let second[U] = func(value U, n int32) U {
                if n == 0 { return value }
                return first[U](value, n - 1)
            }
            """ + "\n" + call);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void ThreeMembers_DifferentInstantiationsAndNestedBodyLowering()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() string {
                let first[T, U] = func(a T, b U, n int32) string {
                    if n == 0 { return "${a}:${b}" }
                    return second[U, T](b, a, n - 1)
                }
                let second[X, Y] = func(a X, b Y, n int32) string {
                    return third(a, b, n)
                }
                let third[A, B] = func(a A, b B, n int32) string {
                    return first[A, B](a, b, n)
                }
                return first(42, "x", 3) + "|" + first("y", 7, 2)
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("x:42|y:7", result.Value);
    }

    [Fact]
    public void RegionStartsAtFirstDeclaration_AndRetainsOuterOverloads()
    {
        var result = EmittedOracle.Evaluate("""
            func second[T](x T, n int32) int32 { return 100 }
            func Run() int32 {
                let before = second(0, 0)
                let first[T] = func(x T) int32 { return second(x) }
                let second[T] = func(x T) int32 { return 7 }
                let inside = func() int32 { return first("x") }
                return before + inside()
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void NestedRegions_KeepOwnSymbolsAndTypeParameters()
    {
        var result = EmittedOracle.Evaluate("""
            let first[T] = func(x T, n int32) int32 {
                let first[U] = func(x U) int32 { return second(x) }
                let second[V] = func(x V) int32 { return 8 }
                return first("nested")
            }
            let second[T] = func(x T, n int32) int32 { return first(x, n) }
            second(42, 1)
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void ConstraintsAndOverloads_AreAvailableBeforeBodies()
    {
        var result = EmittedOracle.Evaluate("""
            open class Animal { func Speak() string { return "animal" } }
            func Run() string {
                let first[T Animal] = func(x T) string { return second(x, 1) }
                let second[U Animal] = func(x U, n int32) string { return x.Speak() }
                let second[V Animal] = func(x V) string { return first(x) }
                return second(Animal())
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("animal", result.Value);
    }

    [Fact]
    public void UsingAndDeferTailBinding_PreserveRegions()
    {
        var result = EmittedOracle.Evaluate("""
            import System.IO
            func Run() int32 {
                using let stream = MemoryStream()
                defer Console.Write("")
                let first[T] = func(x T) int32 { return second(x) }
                let second[U] = func(x U) int32 { return 19 }
                return first("x")
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(19, result.Value);
    }

    [Theory]
    [InlineData("first(0)\nlet first[T] = func(x T) T { return x }", "GS0130")]
    [InlineData("let first[T] = func(x T) T { return second(x) }\nConsole.Write(0)\nlet second[U] = func(x U) U { return x }", "GS0130")]
    [InlineData("let first = func(x int32) int32 { return second(x) }\nlet second = func(x int32) int32 { return first(x) }", "GS0130")]
    [InlineData("let first[T] = func(x T) int32 { return second(0) }\nlet second = func(x int32) int32 { return first(x) }", "GS0130")]
    [InlineData("let second = func(x int32) int32 { return x }\nlet first[T] = func(x T) int32 { return second(0) }", "GS0463")]
    [InlineData("let outer = 1\nlet first[T] = func(x T) int32 { return second(x) }\nlet second[U] = func(x U) int32 { return outer }", "GS0463")]
    [InlineData("let first[T] = func(x T) T { return x }\nlet first[T] = func(x T) T { return x }", "GS0102")]
    [InlineData("let first = 1\nlet first[T] = func(x T) T { return x }", "GS0102")]
    [InlineData("let first[T] = func(x T) T { return x }\nlet first = 1", "GS0102")]
    [InlineData("var first[T] = func(x T) T { return x }", "GS0462")]
    [InlineData("let first[T] = func(x T) T { return second(x) }\nlet second[U] = func(x U) U { }", "GS0100")]
    public void ExclusionsAndExistingDiagnosticsRemain(string body, string diagnostic)
    {
        var result = EmittedOracle.Evaluate("func Run() {\n" + body + "\n}\nRun()");
        Assert.Contains(result.Diagnostics, d => d.Id == diagnostic);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void EnclosingTypeParameters_StillRejected()
    {
        var result = EmittedOracle.Evaluate("""
            func Run[Outer](x Outer) {
                let first[T] = func(x T) int32 { return second(x) }
                let second[U] = func(x U) int32 {
                    let value Outer = default(Outer)
                    return 0
                }
            }
            Run(0)
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0468");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void InvalidForwardConstraint_StillRejected()
    {
        var result = EmittedOracle.Evaluate("""
            class Animal { }
            let first[T] = func(x T) string { return second[int32](0) }
            let second[U Animal] = func(x U) string { return "bad" }
            first("x")
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0152");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void SameSignatureInOuterScope_RemainsAmbiguous()
    {
        var result = EmittedOracle.Evaluate("""
            func second[T](x T) int32 { return 100 }
            func Run() int32 {
                let first[T] = func(x T) int32 { return second(x) }
                let second[U] = func(x U) int32 { return 7 }
                return first(0)
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0266");
    }

    [Fact]
    public void ForwardSignature_PreservesRefParametersAndDefaults()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let first[T] = func(x T, ref cell int32, n int32 = 2) {
                    if n > 0 { second(x, ref cell, n - 1) }
                }
                let second[U] = func(x U, ref cell int32, n int32 = 0) {
                    cell += 1
                    first(x, ref cell, n)
                }
                var cell = 0
                first("x", ref cell)
                return cell
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ForwardSignature_PreservesInOutAndVariadicParameters()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let first[T] = func(in x T, out y T, n int32, xs ...int32) int32 {
                    return second[T](in x, out y, n, xs)
                }
                let second[U] = func(in x U, out y U, n int32, xs ...int32) int32 {
                    if n > 0 { return first[U](in x, out y, n - 1, xs) }
                    y = x
                    return xs[0] + xs[1]
                }
                let x = 17
                var y = 0
                return first[int32](in x, out y, 2, 3, 4) + y
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(24, result.Value);
    }

    [Fact]
    public void AsyncGenericRegion_PreservesPrivateHostAndOwnGenericSlots()
    {
        var result = EmittedOracle.Evaluate("""
            class Example {
                shared {
                    private func Value() int32 { return 31 }
                    func Run() int32 {
                        let first[T] = async func(x T, n int32) int32 {
                            if n == 0 { return Value() }
                            return await second(x, n - 1)
                        }
                        let second[U] = async func(x U, n int32) int32 {
                            return await first(x, n)
                        }
                        return first("x", 2).Result
                    }
                }
            }
            Example.Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(31, result.Value);
    }
}

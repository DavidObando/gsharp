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
    // The all-non-generic forward-reference case this row used to pin
    // ("let first = func...\nlet second = func...") is RESOLVED by #4219's
    // umbrella remainder (non-generic local-function recursion groups) — see
    // Issue4219NonGenericLocalRecursionTests instead. A MIXED generic/non-
    // generic forward reference remains deliberately out of scope (broader
    // parity, not this milestone) and still reports GS0130:
    [InlineData("let first[T] = func(x T) int32 { return second(0) }\nlet second = func(x int32) int32 { return first(x) }", "GS0130")]
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
    public void GenericLocalCallingNonGenericSibling_NoLongerRejected()
    {
        // Issue #4221 follow-up: before #4252, a generic local function
        // calling ANY sibling local function — even a non-capturing,
        // non-generic one — reported GS0463, because the binder rejected
        // every capture of a generic local function wholesale. This shape
        // (`first[T]` merely calls `second`, which captures nothing) was one
        // of the removed GS0463 rows; restored here as the positive case
        // #4252 should have added: it now compiles and runs correctly.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let second = func(x int32) int32 { return x }
                let first[T] = func(x T) int32 { return second(0) }
                return first(1) + first("z")
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0463");
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void GenericLocalCallingSiblingThatCapturesOuterState_SharesCaptureTransitively()
    {
        // Issue #4221 follow-up: the other removed GS0463 row — `first[T]`
        // calls `second[U]`, a sibling generic local function that captures
        // `outer` — `first` itself never reads `outer` directly. Before this
        // fix, removing the blanket GS0463 rejection (#4252) left this shape
        // crashing the emitter with GS9998 ("Variable 'outer' has no local
        // slot"), because nothing propagated `second`'s capture into
        // `first`'s own environment. It must now both compile AND observe
        // the shared cell: each call to `first` still resolves to the same
        // `outer`.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                var outer = 1
                let first[T] = func(x T) int32 { return second(x) }
                let second[U] = func(x U) int32 { return outer }
                return first(9) + first("z")
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0463");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void EnclosingTypeParameters_CompilesAndRunsWithoutGS0468()
    {
        // Issue #4223: `second` referencing the enclosing method's own type
        // parameter `Outer` — via a local variable's declared type and a
        // `default(Outer)` expression, entirely body-only positions — used to
        // report GS0468. `second` (and, transitively, `first`, purely to
        // forward `Outer` to its own call site) is now correctly promoted,
        // for two DIFFERENT `Outer` instantiations in the same run.
        var result = EmittedOracle.Evaluate("""
            func Run[Outer]() string {
                let first[T] = func(a T) string { return second(a) }
                let second[U] = func(a U) string {
                    let value Outer = default(Outer)
                    return typeof(Outer).Name
                }
                return first(1)
            }
            Run[string]() + "|" + Run[int32]()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("String|Int32", result.Value);
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

    [Theory]
    [InlineData("return Secret()", "GS0472")]
    [InlineData("return secret", "GS0472")]
    [InlineData("return Holder[int32].Secret()", "GS0472")]
    [InlineData("return Holder[int32].secret", "GS0472")]
    [InlineData("let value = Holder[int32]()\nreturn 42", "GS0472")]
    [InlineData("let callback () -> int32 = Holder[int32].Secret\nreturn callback()", "GS0586")]
    [InlineData("unsafe { let callback = &Holder[int32].Secret\nreturn callback() }", "GS0472")]
    [InlineData("let nested = func() int32 { return 42 }\nreturn nested()", "GS0586")]
    public void GenericOwnerDependencies_FailBeforeEmission(string body, string diagnostic)
    {
        var result = EmittedOracle.Evaluate($$"""
            class Holder[Outer] {
                private init() { }
                shared {
                    private var secret int32 = 42
                    private func Secret() int32 { return 42 }
                    func Public() int32 { return 42 }
                    func Run() int32 {
                        let first[T] = func(x T) int32 { return second(x) }
                        let second[U] = func(x U) int32 { {{body}} }
                        return first(1)
                    }
                }
            }
            Holder[string].Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == diagnostic);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }

    [Theory]
    [InlineData("return 42")]
    [InlineData("return Holder[int32].Public()")]
    [InlineData("let value = Holder[int32]()\nreturn 42")]
    [InlineData("let callback () -> int32 = Holder[int32].Public\nreturn callback()")]
    public void GenericOwnerIndependentHelpers_RemainSupported(string body)
    {
        var result = EmittedOracle.Evaluate($$"""
            class Holder[Outer] {
                shared {
                    func Public() int32 { return 42 }
                    func Run() int32 {
                        let first[T] = func(x T) int32 { return second(x) }
                        let second[U] = func(x U) int32 { {{body}} }
                        return first(1)
                    }
                }
            }
            Holder[string].Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericOwnerImplicitReceiverCall_CompilesAndRunsWithoutGS0468()
    {
        // Issue #4223: `second`'s implicit-receiver call to `Public()` — a
        // `shared` member of the ENCLOSING generic type `Holder[Outer]` —
        // used to report GS0468 (moved out of GenericOwnerDependencies_FailBeforeEmission
        // above), because the resolved call site is `Holder[Outer].Public()`
        // and `Outer` is referenced only through the call's implicit STATIC
        // OWNER TYPE — a shape `TryPromoteNonCapturingGenericLambda`'s
        // enclosing-type-parameter scan did not check at all. `second` (and,
        // transitively, `first`, which must forward `Outer` purely to supply
        // it at its own call to `second`) is now correctly promoted for two
        // DIFFERENT `Outer` instantiations.
        var resultString = EmittedOracle.Evaluate("""
            class Holder[Outer] {
                shared {
                    func Public() int32 { return 42 }
                    func Run() int32 {
                        let first[T] = func(x T) int32 { return second(x) }
                        let second[U] = func(x U) int32 { return Public() }
                        return first(1)
                    }
                }
            }
            Holder[string].Run()
            """);
        Assert.Empty(resultString.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, resultString.Value);

        var resultInt = EmittedOracle.Evaluate("""
            class Holder[Outer] {
                shared {
                    func Public() int32 { return 42 }
                    func Run() int32 {
                        let first[T] = func(x T) int32 { return second(x) }
                        let second[U] = func(x U) int32 { return Public() }
                        return first(1)
                    }
                }
            }
            Holder[int32].Run()
            """);
        Assert.Empty(resultInt.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, resultInt.Value);
    }

    [Theory]
    [InlineData("return Secret()")]
    [InlineData("return 42")]
    [InlineData("let nested = func() int32 { return Secret() }\nreturn nested()")]
    [InlineData("let nested = func() int32 { return Secret() + \"${x}\".Length - 1 }\nreturn nested()")]
    public void NonGenericInterfaceOwner_PreservesPrivateAccessAndMethodPlanning(string body)
    {
        var result = EmittedOracle.Evaluate($$"""
            interface Holder {
                shared {
                    private func Secret() int32 { return 42 }
                    func Run() int32 {
                        let first[T] = func(x T) int32 { return second(x) }
                        let second[U] = func(x U) int32 { {{body}} }
                        return first(1)
                    }
                }
            }
            Holder.Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }
}

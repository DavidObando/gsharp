// <copyright file="Issue3271ReifiedGenericArgumentBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3271: value-type arguments passed through a reified generic slot
/// whose call-site type argument is a reference type must be boxed before the
/// call.
/// </summary>
public class Issue3271ReifiedGenericArgumentBoxingTests
{
    [Fact]
    public void TopLevel_ValueTypes_BoxToObject()
    {
        AssertRuns(
            """
            package Issue3271TopObject
            import System

            struct Token { var Value int32 }

            func Show[T](value T, label string) {
                Console.WriteLine(label)
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
            }

            Show[object](11, "int")
            Show[object](true, "bool")
            Show[object](Token{Value: 7}, "struct")
            """,
            "int",
            "System.Object[]",
            "System.Int32",
            "bool",
            "System.Object[]",
            "System.Boolean",
            "struct",
            "System.Object[]",
            "Issue3271TopObject.Token");
    }

    [Fact]
    public void TopLevel_ValueTypes_BoxToInterfacesAndValueType()
    {
        AssertRuns(
            """
            package Issue3271TopReferences
            import System

            interface IMark { func Code() int32; }
            struct Mark : IMark {
                var Value int32
                func Code() int32 { return Value }
            }

            func Show[T](value T, label string) {
                Console.WriteLine(label)
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
            }

            Show[IComparable](21, "imported-interface")
            Show[IMark](Mark{Value: 22}, "user-interface")
            """,
            "imported-interface",
            "System.IComparable[]",
            "System.Int32",
            "user-interface",
            "Issue3271TopReferences.IMark[]",
            "Issue3271TopReferences.Mark");

        AssertRuns(
            """
            package Issue3271TopValueType
            import System

            func Show[T](value T) {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }

            Show[ValueType](23)
            """,
            "System.ValueType[]",
            "System.Int32",
            "23");
    }

    [Fact]
    public void GenericInstanceMethod_BoxesReferenceTargets()
    {
        AssertRuns(
            """
            package Issue3271Instance
            import System

            class Runner {
                init() {}

                func Show[T](value T, label string) {
                    Console.WriteLine(label)
                    Console.WriteLine([]T{value}.GetType())
                    Console.WriteLine(value.GetType())
                }
            }

            let runner = Runner()
            runner.Show[object](31, "object")
            runner.Show[IComparable](32, "interface")
            """,
            "object",
            "System.Object[]",
            "System.Int32",
            "interface",
            "System.IComparable[]",
            "System.Int32");

        AssertRuns(
            """
            package Issue3271InstanceValueType
            import System

            class Runner {
                init() {}
                func Show[T](value T) {
                    Console.WriteLine([]T{value}.GetType())
                    Console.WriteLine(value.GetType())
                    Console.WriteLine(value)
                }
            }

            Runner().Show[ValueType](33)
            """,
            "System.ValueType[]",
            "System.Int32",
            "33");
    }

    [Fact]
    public void GenericExtensionMethod_BoxesReferenceTargets()
    {
        AssertRuns(
            """
            package Issue3271Extension
            import System

            func (self string) Show[T](value T, label string) {
                Console.WriteLine(self + ":" + label)
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
            }

            "extension".Show[object](41, "object")
            "extension".Show[IComparable](42, "interface")
            """,
            "extension:object",
            "System.Object[]",
            "System.Int32",
            "extension:interface",
            "System.IComparable[]",
            "System.Int32");

        AssertRuns(
            """
            package Issue3271ExtensionValueType
            import System

            func (self string) Show[T](value T) {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }

            "extension".Show[ValueType](43)
            """,
            "System.ValueType[]",
            "System.Int32",
            "43");
    }

    [Fact]
    public void ConstructedGenericOwner_InstanceMethods_BoxReferenceTargets()
    {
        AssertRuns(
            """
            package Issue3271Owner
            import System

            class Box[T](_seed T) {
                func Show(value T, label string) {
                    Console.WriteLine(label)
                    Console.WriteLine([]T{value}.GetType())
                    Console.WriteLine(value.GetType())
                }
            }

            open class Base[T] {
                init() {}
                func Show(value T, label string) {
                    Console.WriteLine(label)
                    Console.WriteLine([]T{value}.GetType())
                    Console.WriteLine(value.GetType())
                }
            }

            class Derived : Base[object] {
                init() : base() {}
            }

            struct Outer[T] {
                struct Middle {
                    func Show(value T, label string) {
                        Console.WriteLine(label)
                        Console.WriteLine([]T{value}.GetType())
                        Console.WriteLine(value.GetType())
                    }
                }
            }

            Box[object]("seed").Show(51, "direct")
            Derived().Show(52, "inherited")
            let middle = default(Outer[object].Middle)
            middle.Show(53, "nested")
            """,
            "direct",
            "System.Object[]",
            "System.Int32",
            "inherited",
            "System.Object[]",
            "System.Int32",
            "nested",
            "System.Object[]",
            "System.Int32");
    }

    [Fact]
    public void NullableReferenceTypeArgument_StillBoxesValue()
    {
        AssertRuns(
            """
            package Issue3271NullableReference
            import System

            func Show[T](value T) {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
            }

            Show[object?](61)
            """,
            "System.Object[]",
            "System.Int32");
    }

    [Fact]
    public void ReifiedTypeArgumentOrder_IsNotErasedOrTransposed()
    {
        AssertRuns(
            """
            package Issue3271Order
            import System

            func Pair[A, B](a A, b B) {
                Console.WriteLine([]A{a}.GetType())
                Console.WriteLine([]B{b}.GetType())
                Console.WriteLine(a.GetType())
                Console.WriteLine(b.GetType())
            }

            Pair[object, string](71, "right")
            Pair[string, object]("left", 72)
            """,
            "System.Object[]",
            "System.String[]",
            "System.Int32",
            "System.String",
            "System.String[]",
            "System.Object[]",
            "System.String",
            "System.Int32");
    }

    [Fact]
    public void ValueTypeTargets_StayUnboxed()
    {
        AssertRuns(
            """
            package Issue3271ValueTargets
            import System

            func Unconstrained[T](value T) {
                Console.WriteLine([]T{value}.GetType())
            }

            func Constrained[T struct](value T) {
                Console.WriteLine([]T{value}.GetType())
            }

            func NullableArgument[T](value T) {
                Console.WriteLine([]T{value}.GetType())
            }

            func NullableParameter[T struct](value T?) {
                Console.WriteLine([]T?{value}.GetType())
                Console.WriteLine(value!!)
            }

            Unconstrained[int32](81)
            Constrained[int32](82)
            var nullable int32? = 83
            NullableArgument[int32?](nullable)
            NullableParameter[int32](nullable)
            """,
            "System.Int32[]",
            "System.Int32[]",
            "System.Nullable`1[System.Int32][]",
            "System.Nullable`1[System.Int32][]",
            "83");
    }

    [Fact]
    public void ExistingSharedAndReferencePaths_StayCorrect()
    {
        AssertRuns(
            """
            package Issue3271Controls
            import System

            interface IMark { func Code() int32; }
            class Mark : IMark {
                init() {}
                func Code() int32 { return 91 }
            }

            class Runner {
                shared {
                    func Show[T](value T) {
                        Console.WriteLine([]T{value}.GetType())
                        Console.WriteLine(value.GetType())
                    }
                }
            }

            func Show[T](value T) {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
            }

            Runner.Show[object](91)
            Runner.Show[IComparable](92)
            Show[object]("right")
            Show[IMark](Mark())
            """,
            "System.Object[]",
            "System.Int32",
            "System.IComparable[]",
            "System.Int32",
            "System.Object[]",
            "System.String",
            "Issue3271Controls.IMark[]",
            "Issue3271Controls.Mark");
    }

    private static void AssertRuns(string source, params string[] expectedLines)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.ExitCode);
        Assert.Null(result.UnhandledException);
        Assert.Equal(string.Empty, result.ErrorOutput);
        Assert.Equal(
            string.Join(Environment.NewLine, expectedLines) + Environment.NewLine,
            result.Output);
    }

}

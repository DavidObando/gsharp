// <copyright file="Issue3280ValueTypeBaseBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3280: CLR value types box implicitly to <see cref="ValueType"/>,
/// and enum values box implicitly to <see cref="Enum"/>, in every call shape.
/// </summary>
public sealed class Issue3280ValueTypeBaseBoxingTests
{
    [Theory]
    [InlineData("top-level")]
    [InlineData("instance")]
    [InlineData("extension")]
    [InlineData("shared")]
    public void ValueTypeReferenceBases_BoxAndRun_InEveryCallShape(string shape)
    {
        AssertRuns(
            MatrixSource(shape),
            "System.ValueType[]",
            "System.Int32",
            "5",
            "System.Enum[]",
            "System.DayOfWeek",
            "Sunday",
            "System.Object[]",
            "System.Int32",
            "11",
            "System.ValueType[]",
            "System.Int32",
            "22",
            "System.Enum[]",
            "System.DayOfWeek",
            "Monday",
            "System.DayOfWeek[]",
            "System.DayOfWeek",
            "Tuesday");
    }

    [Fact]
    public void AlreadyBoxedValueTypeArgument_PreservesTargetTypeAndValue()
    {
        AssertRuns(
            """
            package Issue3280AlreadyBoxed
            import System

            func Show[T](value T) {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }

            let boxed ValueType = 31
            Show[ValueType](boxed)
            """,
            "System.ValueType[]",
            "System.Int32",
            "31");
    }

    [Fact]
    public void ReferenceTypeArgument_RemainsReferenceTyped()
    {
        Assert.False(
            Conversion.Classify(
                TypeSymbol.String,
                TypeSymbol.FromClrType(typeof(ValueType))).Exists);
        Assert.False(
            Conversion.Classify(
                TypeSymbol.Int32,
                TypeSymbol.FromClrType(typeof(Enum))).Exists);

        AssertRuns(
            """
            package Issue3280ReferenceControl
            import System

            func Show[T](value T) {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }

            Show[object]("right")
            """,
            "System.Object[]",
            "System.String",
            "right");
    }

    [Fact]
    public void ReifiedValueTypeParameter_RemainsUnboxed()
    {
        AssertRuns(
            """
            package Issue3280ReifiedValueControl
            import System

            func Show[T](value T) {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }

            func Forward[T](value T) {
                Show[T](value)
            }

            Forward[int32](41)
            """,
            "System.Int32[]",
            "System.Int32",
            "41");
    }

    [Fact]
    public void StructConstrainedTypeParameter_BoxesToValueType()
    {
        AssertRuns(
            """
            package Issue3280StructConstraint
            import System

            func Take(value ValueType) {
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }

            func Forward[T struct](value T) {
                Take(value)
            }

            Forward[int32](42)
            """,
            "System.Int32",
            "42");
    }

    [Fact]
    public void NullableValueTypeParameter_RemainsUnboxed()
    {
        AssertRuns(
            """
            package Issue3280NullableValueControl
            import System

            func Show[T](value T) {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }

            var value int32? = 51
            Show[int32?](value)
            """,
            "System.Nullable`1[System.Int32][]",
            "System.Int32",
            "51");
    }

    [Fact]
    public void ConstrainedMutableStruct_RemainsMutable()
    {
        AssertRuns(
            """
            package Issue3280MutableStructControl
            import System

            interface IMutable {
                func Bump();
                func Read() int32;
            }

            struct Counter : IMutable {
                var Value int32
                func Bump() { Value = Value + 1 }
                func Read() int32 { return Value }
            }

            func Mutate[T IMutable](value T) T {
                value.Bump()
                return value
            }

            let result = Mutate[Counter](Counter{Value: 60})
            Console.WriteLine(result.Read())
            """,
            "61");
    }

    private static string MatrixSource(string shape)
    {
        const string genericMethodBody = """
            {
                Console.WriteLine([]T{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }
            """;
        const string valueTypeMethodBody = """
            {
                Console.WriteLine([]ValueType{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }
            """;
        const string enumMethodBody = """
            {
                Console.WriteLine([]Enum{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }
            """;

        var declaration = shape switch
        {
            "top-level" => "func TakeValueType(value ValueType) " + valueTypeMethodBody
                + " func TakeEnum(value Enum) " + enumMethodBody
                + " func Show[T](value T) " + genericMethodBody,
            "instance" => "class Runner { init() {} func TakeValueType(value ValueType) " + valueTypeMethodBody
                + " func TakeEnum(value Enum) " + enumMethodBody
                + " func Show[T](value T) " + genericMethodBody + " }",
            "extension" => "func (self string) TakeValueType(value ValueType) " + valueTypeMethodBody
                + " func (self string) TakeEnum(value Enum) " + enumMethodBody
                + " func (self string) Show[T](value T) " + genericMethodBody,
            "shared" => "class Runner { shared { func TakeValueType(value ValueType) " + valueTypeMethodBody
                + " func TakeEnum(value Enum) " + enumMethodBody
                + " func Show[T](value T) " + genericMethodBody + " } }",
            _ => throw new ArgumentOutOfRangeException(nameof(shape)),
        };
        var target = shape switch
        {
            "top-level" => string.Empty,
            "instance" => "Runner().",
            "extension" => "\"receiver\".",
            "shared" => "Runner.",
            _ => throw new ArgumentOutOfRangeException(nameof(shape)),
        };

        return $$"""
            package Issue3280{{shape.Replace("-", string.Empty, StringComparison.Ordinal)}}
            import System

            {{declaration}}

            {{target}}TakeValueType(5)
            {{target}}TakeEnum(DayOfWeek.Sunday)
            {{target}}Show[object](11)
            {{target}}Show[ValueType](22)
            {{target}}Show[Enum](DayOfWeek.Monday)
            {{target}}Show[DayOfWeek](DayOfWeek.Tuesday)
            """;
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

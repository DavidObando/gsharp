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
/// and enum values box implicitly to <see cref="Enum"/>, <see cref="ValueType"/>,
/// and <see cref="object"/>, in every call shape.
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
            "42",
            "System.ValueType[]",
            "System.DayOfWeek",
            "Friday",
            "System.Enum[]",
            "System.DayOfWeek",
            "Sunday",
            "System.Object[]",
            "System.DayOfWeek",
            "Monday",
            "System.IComparable[]",
            "System.Int32",
            "7",
            "System.Object[]",
            "System.Int32",
            "11",
            "System.IComparable[]",
            "System.Int32",
            "12",
            "System.ValueType[]",
            "System.Int32",
            "22",
            "System.ValueType[]",
            "System.DayOfWeek",
            "Saturday",
            "System.Enum[]",
            "System.DayOfWeek",
            "Tuesday",
            "System.Object[]",
            "System.DayOfWeek",
            "Wednesday",
            "System.DayOfWeek[]",
            "System.DayOfWeek",
            "Thursday");
    }

    [Fact]
    public void ReferenceBaseUpcasts_PreserveExistingBox()
    {
        AssertRuns(
            """
            package Issue3280ReferenceBaseUpcasts
            import System

            func Reify[T](value T) T -> value

            let enumReference Enum = DayOfWeek.Wednesday
            let valueTypeReference = Reify[ValueType](enumReference)
            let objectReference = Reify[object](valueTypeReference)

            Console.WriteLine(Object.ReferenceEquals(enumReference, valueTypeReference))
            Console.WriteLine(Object.ReferenceEquals(valueTypeReference, objectReference))
            Console.WriteLine([]ValueType{valueTypeReference}.GetType())
            Console.WriteLine(objectReference.GetType())
            Console.WriteLine(objectReference)
            """,
            "True",
            "True",
            "System.ValueType[]",
            "System.DayOfWeek",
            "Wednesday");
    }

    [Fact]
    public void ConversionClassifier_UsesClrBoxingAndReferenceRules()
    {
        var valueType = TypeSymbol.FromClrType(typeof(ValueType));
        var enumType = TypeSymbol.FromClrType(typeof(Enum));
        var dayOfWeek = TypeSymbol.FromClrType(typeof(DayOfWeek));

        Assert.True(Conversion.Classify(TypeSymbol.Int32, valueType).IsImplicit);
        Assert.True(Conversion.Classify(dayOfWeek, valueType).IsImplicit);
        Assert.True(Conversion.Classify(dayOfWeek, enumType).IsImplicit);
        Assert.True(Conversion.Classify(dayOfWeek, TypeSymbol.Object).IsImplicit);
        Assert.True(Conversion.Classify(enumType, valueType).IsImplicit);
        Assert.True(Conversion.Classify(valueType, TypeSymbol.Object).IsImplicit);
        Assert.False(
            Conversion.Classify(
                TypeSymbol.String,
                valueType).Exists);
        Assert.False(
            Conversion.Classify(
                TypeSymbol.Int32,
                enumType).Exists);

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
    public void StructConstrainedTypeParameter_BoxesWhenReifiedToValueType()
    {
        AssertRuns(
            """
            package Issue3280StructConstraint
            import System

            func Reify[T](value T) T -> value

            func Box[T struct](value T) ValueType -> Reify[ValueType](value)

            let boxed = Box[int32](42)
            Console.WriteLine([]ValueType{boxed}.GetType())
            Console.WriteLine(boxed.GetType())
            Console.WriteLine(boxed)
            """,
            "System.ValueType[]",
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
        const string objectMethodBody = """
            {
                Console.WriteLine([]object{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }
            """;
        const string comparableMethodBody = """
            {
                Console.WriteLine([]IComparable{value}.GetType())
                Console.WriteLine(value.GetType())
                Console.WriteLine(value)
            }
            """;

        var declaration = shape switch
        {
            "top-level" => "func TakeValueType(value ValueType) " + valueTypeMethodBody
                + " func TakeEnum(value Enum) " + enumMethodBody
                + " func TakeObject(value object) " + objectMethodBody
                + " func TakeComparable(value IComparable) " + comparableMethodBody
                + " func Show[T](value T) " + genericMethodBody,
            "instance" => "class Runner { init() {} func TakeValueType(value ValueType) " + valueTypeMethodBody
                + " func TakeEnum(value Enum) " + enumMethodBody
                + " func TakeObject(value object) " + objectMethodBody
                + " func TakeComparable(value IComparable) " + comparableMethodBody
                + " func Show[T](value T) " + genericMethodBody + " }",
            "extension" => "func (self string) TakeValueType(value ValueType) " + valueTypeMethodBody
                + " func (self string) TakeEnum(value Enum) " + enumMethodBody
                + " func (self string) TakeObject(value object) " + objectMethodBody
                + " func (self string) TakeComparable(value IComparable) " + comparableMethodBody
                + " func (self string) Show[T](value T) " + genericMethodBody,
            "shared" => "class Runner { shared { func TakeValueType(value ValueType) " + valueTypeMethodBody
                + " func TakeEnum(value Enum) " + enumMethodBody
                + " func TakeObject(value object) " + objectMethodBody
                + " func TakeComparable(value IComparable) " + comparableMethodBody
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

            {{target}}TakeValueType(42)
            {{target}}TakeValueType(DayOfWeek.Friday)
            {{target}}TakeEnum(DayOfWeek.Sunday)
            {{target}}TakeObject(DayOfWeek.Monday)
            {{target}}TakeComparable(7)
            {{target}}Show[object](11)
            {{target}}Show[IComparable](12)
            {{target}}Show[ValueType](22)
            {{target}}Show[ValueType](DayOfWeek.Saturday)
            {{target}}Show[Enum](DayOfWeek.Tuesday)
            {{target}}Show[object](DayOfWeek.Wednesday)
            {{target}}Show[DayOfWeek](DayOfWeek.Thursday)
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

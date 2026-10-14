// <copyright file="Issue3280ValueTypeBaseBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import System
import Xunit

/// Issue #3280: CLR value types box implicitly to (cref:ValueType),
/// and enum values box implicitly to (cref:Enum), (cref:ValueType),
/// and (cref:object), in every call shape.
class Issue3280ValueTypeBaseBoxingTests {
    @Theory
    @InlineData("top-level")
    @InlineData("instance")
    @InlineData("extension")
    @InlineData("shared")
    func ValueTypeReferenceBases_BoxAndRun_InEveryCallShape(shape string) {
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
            "Thursday"
        )
    }

    @Fact
    func ReferenceBaseUpcasts_PreserveExistingBox() {
        AssertRuns(`package Issue3280ReferenceBaseUpcasts
import System

func Reify[T](value T) T -> value

let enumReference Enum = DayOfWeek.Wednesday
let valueTypeReference = Reify[ValueType](enumReference)
let objectReference = Reify[object](valueTypeReference)

Console.WriteLine(Object.ReferenceEquals(enumReference, valueTypeReference))
Console.WriteLine(Object.ReferenceEquals(valueTypeReference, objectReference))
Console.WriteLine([]ValueType{valueTypeReference}.GetType())
Console.WriteLine(objectReference.GetType())
Console.WriteLine(objectReference)`, "True", "True", "System.ValueType[]", "System.DayOfWeek", "Wednesday")
    }

    @Fact
    func ConversionClassifier_UsesClrBoxingAndReferenceRules() {
        let valueType = TypeSymbol.FromClrType(typeof(ValueType))
        let enumType = TypeSymbol.FromClrType(typeof(Enum))
        let dayOfWeek = TypeSymbol.FromClrType(typeof(DayOfWeek))
        Assert.True(Conversion.Classify(TypeSymbol.Int32, valueType).IsImplicit)
        Assert.True(Conversion.Classify(dayOfWeek, valueType).IsImplicit)
        Assert.True(Conversion.Classify(dayOfWeek, enumType).IsImplicit)
        Assert.True(Conversion.Classify(dayOfWeek, TypeSymbol.Object).IsImplicit)
        Assert.True(Conversion.Classify(enumType, valueType).IsImplicit)
        Assert.True(Conversion.Classify(valueType, TypeSymbol.Object).IsImplicit)
        Assert.False(Conversion.Classify(TypeSymbol.String, valueType).Exists)
        Assert.False(Conversion.Classify(TypeSymbol.Int32, enumType).Exists)
        AssertRuns(`package Issue3280ReferenceControl
import System

func Show[T](value T) {
    Console.WriteLine([]T{value}.GetType())
    Console.WriteLine(value.GetType())
    Console.WriteLine(value)
}

Show[object]("right")`, "System.Object[]", "System.String", "right")
    }

    @Fact
    func ReifiedValueTypeParameter_RemainsUnboxed() {
        AssertRuns(`package Issue3280ReifiedValueControl
import System

func Show[T](value T) {
    Console.WriteLine([]T{value}.GetType())
    Console.WriteLine(value.GetType())
    Console.WriteLine(value)
}

func Forward[T](value T) {
    Show[T](value)
}

Forward[int32](41)`, "System.Int32[]", "System.Int32", "41")
    }

    @Fact
    func StructConstrainedTypeParameter_BoxesWhenReifiedToValueType() {
        AssertRuns(`package Issue3280StructConstraint
import System

func Reify[T](value T) T -> value

func Box[T struct](value T) ValueType -> Reify[ValueType](value)

let boxed = Box[int32](42)
Console.WriteLine([]ValueType{boxed}.GetType())
Console.WriteLine(boxed.GetType())
Console.WriteLine(boxed)`, "System.ValueType[]", "System.Int32", "42")
    }

    @Fact
    func NullableValueTypeParameter_RemainsUnboxed() {
        AssertRuns(`package Issue3280NullableValueControl
import System

func Show[T](value T) {
    Console.WriteLine([]T{value}.GetType())
    Console.WriteLine(value.GetType())
    Console.WriteLine(value)
}

var value int32? = 51
Show[int32?](value)`, "System.Nullable`1[System.Int32][]", "System.Int32", "51")
    }

    @Fact
    func ConstrainedMutableStruct_RemainsMutable() {
        AssertRuns(`package Issue3280MutableStructControl
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
Console.WriteLine(result.Read())`, "61")
    }

    shared {
        private func MatrixSource(shape string) string {
            const genericMethodBody = `{
    Console.WriteLine([]T{value}.GetType())
    Console.WriteLine(value.GetType())
    Console.WriteLine(value)
}`
            const valueTypeMethodBody = `{
    Console.WriteLine([]ValueType{value}.GetType())
    Console.WriteLine(value.GetType())
    Console.WriteLine(value)
}`
            const enumMethodBody = `{
    Console.WriteLine([]Enum{value}.GetType())
    Console.WriteLine(value.GetType())
    Console.WriteLine(value)
}`
            const objectMethodBody = `{
    Console.WriteLine([]object{value}.GetType())
    Console.WriteLine(value.GetType())
    Console.WriteLine(value)
}`
            const comparableMethodBody = `{
    Console.WriteLine([]IComparable{value}.GetType())
    Console.WriteLine(value.GetType())
    Console.WriteLine(value)
}`
            let declaration = switch shape {
                case "top-level": "func TakeValueType(value ValueType) " +
                    valueTypeMethodBody +
                    " func TakeEnum(value Enum) " +
                    enumMethodBody +
                    " func TakeObject(value object) " +
                    objectMethodBody +
                    " func TakeComparable(value IComparable) " +
                    comparableMethodBody +
                    " func Show[T](value T) " +
                    genericMethodBody
                case "instance": "class Runner { init() {} func TakeValueType(value ValueType) " +
                    valueTypeMethodBody +
                    " func TakeEnum(value Enum) " +
                    enumMethodBody +
                    " func TakeObject(value object) " +
                    objectMethodBody +
                    " func TakeComparable(value IComparable) " +
                    comparableMethodBody +
                    " func Show[T](value T) " +
                    genericMethodBody +
                    " }"
                case "extension": "func (self string) TakeValueType(value ValueType) " +
                    valueTypeMethodBody +
                    " func (self string) TakeEnum(value Enum) " +
                    enumMethodBody +
                    " func (self string) TakeObject(value object) " +
                    objectMethodBody +
                    " func (self string) TakeComparable(value IComparable) " +
                    comparableMethodBody +
                    " func (self string) Show[T](value T) " +
                    genericMethodBody
                case "shared": "class Runner { shared { func TakeValueType(value ValueType) " +
                    valueTypeMethodBody +
                    " func TakeEnum(value Enum) " +
                    enumMethodBody +
                    " func TakeObject(value object) " +
                    objectMethodBody +
                    " func TakeComparable(value IComparable) " +
                    comparableMethodBody +
                    " func Show[T](value T) " +
                    genericMethodBody +
                    " } }"
                default: throw ArgumentOutOfRangeException("shape")
            }
            let target = switch shape {
                case "top-level": string.Empty
                case "instance": "Runner()."
                case "extension": "\"receiver\"."
                case "shared": "Runner."
                default: throw ArgumentOutOfRangeException("shape")
            }
            return (`package Issue3280` + "${shape.Replace("-", string.Empty, StringComparison.Ordinal)}" + `
import System

` + "$declaration" + `

` + "$target" + `TakeValueType(42)
` + "$target" + `TakeValueType(DayOfWeek.Friday)
` + "$target" + `TakeEnum(DayOfWeek.Sunday)
` + "$target" + `TakeObject(DayOfWeek.Monday)
` + "$target" + `TakeComparable(7)
` + "$target" + `Show[object](11)
` + "$target" + `Show[IComparable](12)
` + "$target" + `Show[ValueType](22)
` + "$target" + `Show[ValueType](DayOfWeek.Saturday)
` + "$target" + `Show[Enum](DayOfWeek.Tuesday)
` + "$target" + `Show[object](DayOfWeek.Wednesday)
` + "$target" + `Show[DayOfWeek](DayOfWeek.Thursday)`)
        }

        private func AssertRuns(source string, expectedLines ...string) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(0, result.ExitCode)
            Assert.Null(result.UnhandledException)
            Assert.Equal(string.Empty, result.ErrorOutput)
            Assert.Equal(string.Join(Environment.NewLine, expectedLines) + Environment.NewLine, result.Output)
        }
    }
}

// <copyright file="Issue5681NullableRelationalPatternDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import Xunit

/// Issue #5681: a relational pattern on a value-type `T?` input has the lifted operator result.
/// A nil input does not match an ordering pattern, and a present input compares as `T`.
class Issue5681NullableRelationalPatternDriverTests {
    @Fact
    func IsAndSwitchForms_TestHasValueAndCompareTheUnderlyingValue() {
        const source = `func Bit(value bool) string -> if value { "1" } else { "0" }
func D(n int32?) bool -> n is 1 and > 0
func E(n int32?) bool -> n is > 0
func H(n int32?) int32 -> switch n {
    case > 0: 1
    default: 0
}
func S(n int32?) int32 {
    switch n {
        case > 10 {
            return 2
        }
        case > 0 {
            return 1
        }
        default {
            return 0
        }
    }
}
func Sign(n int32?) string -> switch n {
    case < 0: "-"
    case 0: "0"
    case > 0: "+"
    default: "n"
}
func Constant(n int32?) bool -> n is 1
System.Console.Write(Bit(D(1)) + Bit(D(2)) + Bit(D(nil)) + "|")
System.Console.Write(Bit(E(1)) + Bit(E(0)) + Bit(E(nil)) + "|")
System.Console.Write("${H(2)}${H(0)}${H(nil)}|${S(11)}${S(1)}${S(0)}${S(nil)}|")
System.Console.Write(Sign(-4) + Sign(0) + Sign(4) + Sign(nil) + "|")
System.Console.Write(Bit(Constant(1)) + Bit(Constant(2)) + Bit(Constant(nil)))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "100|100|100|2100|-0+n|100", "5681")
    }

    @Fact
    func Combinators_NotMatchesNilAndOrAndShortCircuit() {
        const source = `func Bit(value bool) string -> if value { "1" } else { "0" }
func Not(n int32?) bool -> n is not > 0
func Or(n int32?) bool -> n is 1 or > 5
func Range(n int32?) bool -> n is > 0 and < 10
func Present(n int32?) bool -> n is not nil and >= 0
System.Console.Write(Bit(Not(1)) + Bit(Not(0)) + Bit(Not(nil)) + "|")
System.Console.Write(Bit(Or(1)) + Bit(Or(6)) + Bit(Or(3)) + Bit(Or(nil)) + "|")
System.Console.Write(Bit(Range(5)) + Bit(Range(10)) + Bit(Range(nil)) + "|")
System.Console.Write(Bit(Present(0)) + Bit(Present(-1)) + Bit(Present(nil)))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "011|1100|100|100", "5681")
    }

    @Fact
    func Subpatterns_OnNullableMembersAndElements() {
        const source = `func Bit(value bool) string -> if value { "1" } else { "0" }
class Box {
    prop P int32? { get; set; }
}
func Property(box Box) bool -> box is { P: > 0 }
func Tuple(pair (int32?, int32)) bool -> pair is { Item1: >= 2 }
func List(items []int32?) bool -> items is [> 0, _]
System.Console.Write(Bit(Property(Box{P: 3})) + Bit(Property(Box{P: 0})) + Bit(Property(Box{P: nil})) + "|")
System.Console.Write(Bit(Tuple((2, 0))) + Bit(Tuple((1, 0))) + Bit(Tuple((nil, 0))) + "|")
System.Console.Write(Bit(List([]int32?{1, 2})) + Bit(List([]int32?{0, 2})) + Bit(List([]int32?{nil, 2})))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "100|100|100", "5681")
    }

    @Fact
    func OtherValueTypes_UseTheUnderlyingComparisonRules() {
        const source = `import System
enum Color { Red, Green, Blue }
func Bit(value bool) string -> if value { "1" } else { "0" }
func Wide(n int64?) bool -> n is > 0
func Less(n float64?) bool -> n is < 1.5
func AtMost(n float64?) bool -> n is <= 1.5
func Money(n decimal?) bool -> n is > 1.5m
func Letter(n char?) bool -> n is >= 'b'
func Unsigned(n uint32?) bool -> n is > 1u
func Small(n uint8?) bool -> n is > 0
func Day(n DayOfWeek?) bool -> n is > DayOfWeek.Monday
func Hue(n Color?) bool -> n is > Color.Red
System.Console.Write(Bit(Wide(5000000000L)) + Bit(Wide(0L)) + Bit(Wide(nil)) + "|")
System.Console.Write(Bit(Less(1.0)) + Bit(Less(2.0)) + Bit(Less(Double.NaN)) + Bit(Less(nil)) + "|")
System.Console.Write(Bit(AtMost(1.5)) + Bit(AtMost(Double.NaN)) + Bit(AtMost(nil)) + "|")
System.Console.Write(Bit(Money(2m)) + Bit(Money(1m)) + Bit(Money(nil)) + "|")
System.Console.Write(Bit(Letter('c')) + Bit(Letter('a')) + Bit(Letter(nil)) + "|")
System.Console.Write(Bit(Unsigned(4294967295u)) + Bit(Unsigned(0u)) + Bit(Unsigned(nil)) + "|")
System.Console.Write(Bit(Small(uint8(200))) + Bit(Small(uint8(0))) + Bit(Small(nil)) + "|")
System.Console.Write(Bit(Day(DayOfWeek.Friday)) + Bit(Day(DayOfWeek.Sunday)) + Bit(Day(nil)) + "|")
System.Console.Write(Bit(Hue(Color.Blue)) + Bit(Hue(Color.Red)) + Bit(Hue(nil)))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "100|1000|100|100|100|100|100|100|100",
            "5681"
        )
    }

    @Fact
    func EqualityAndNullableValues_HaveTheLiftedOperatorResult() {
        const source = `func Bit(value bool) string -> if value { "1" } else { "0" }
func Same(n int32?) bool -> n is == 3
func Different(n int32?) bool -> n is != 3
func Missing(n int32?) bool -> n is == nil
func Known(n int32?) bool -> n is != nil
func Above(n int32?, m int32?) bool -> n is > m
func Equal(n int32?, m int32?) bool -> n is == m
func Unequal(n int32?, m int32?) bool -> n is != m
System.Console.Write(Bit(Same(3)) + Bit(Same(4)) + Bit(Same(nil)) + "|")
System.Console.Write(Bit(Different(3)) + Bit(Different(4)) + Bit(Different(nil)) + "|")
System.Console.Write(Bit(Missing(nil)) + Bit(Missing(3)) + Bit(Known(3)) + Bit(Known(nil)) + "|")
System.Console.Write(Bit(Above(2, 1)) + Bit(Above(1, 2)) + Bit(Above(2, nil)) + Bit(Above(nil, 1)) + "|")
System.Console.Write(Bit(Equal(2, 2)) + Bit(Equal(2, 1)) + Bit(Equal(nil, nil)) + Bit(Equal(2, nil)) + "|")
System.Console.Write(Bit(Unequal(2, 2)) + Bit(Unequal(2, 1)) + Bit(Unequal(nil, nil)) + Bit(Unequal(nil, 2)))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "100|011|1010|1000|1010|0101",
            "5681"
        )
    }

    @Fact
    func NilInput_StillEvaluatesTheValueOnceInSourceOrder() {
        const source = `class Trace {
    shared {
        var Events string = ""
    }
}
func Bit(value bool) string -> if value { "1" } else { "0" }
func Input(n int32?) int32? {
    Trace.Events += "i"
    return n
}
func Next() int32 {
    Trace.Events += "v"
    return 0
}
func Above(n int32?) bool -> Input(n) is > Next()
func Different(n int32?) bool -> Input(n) is != Next()
System.Console.Write(Bit(Above(1)) + Bit(Above(nil)) + Bit(Different(nil)) + Bit(Different(0)) + "|" + Trace.Events)
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "1010|iviviviv", "5681")
    }

    @Fact
    func DecimalInput_CallsTheDecimalOperators() {
        const source = `func Bit(value bool) string -> if value { "1" } else { "0" }
func Above(n decimal) bool -> n is > 1.5m
func AtLeast(n decimal) bool -> n is >= 1.5m
func Same(n decimal) bool -> n is == 1.5m
func Different(n decimal) bool -> n is != 1.5m
System.Console.Write(Bit(Above(2m)) + Bit(Above(1.5m)) + Bit(Above(1m)) + "|")
System.Console.Write(Bit(AtLeast(2m)) + Bit(AtLeast(1.5m)) + Bit(AtLeast(1m)) + "|")
System.Console.Write(Bit(Same(1.50m)) + Bit(Same(2m)) + Bit(Different(1.50m)) + Bit(Different(2m)))
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "100|110|1001", "5681")
    }
}

// <copyright file="Issue5805ConstantBindingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

class Issue5805ConstantBindingTests {
    @Theory
    @InlineData("cast[object](float64.NaN)")
    @InlineData("cast[object?](float64.NaN)")
    @InlineData("cast[object](float32.NaN)")
    @InlineData("cast[object?](float32.NaN)")
    func ExplicitBoxedNaN_UsesObjectEquality(value string) {
        let floatType = if value.Contains("float32") {
            "float32"
        } else {
            "float64"
        }
        let inputType = if value.Contains("object?") {
            "object?"
        } else {
            "object"
        }
        let result = EmittedOracle.Evaluate("let v $inputType = $floatType.NaN\nv is ($value)")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("True", result.ValueText)
    }

    @Fact
    func ExplicitBoxedPatternEquality_InvalidatesClosureAssignedNarrowing() {
        let result = EmittedOracle.Evaluate(`
func Read(value object) int32 {
    var text string? = "ok"
    let clear = () -> { text = nil }
    if text != nil {
        let matches = value is (cast[object](float64.NaN))
        return text.Length
    }
    return 0
}
Read(float64.NaN)
`)
        let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0158"))
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData("cast[object?](nil)")
    @InlineData("P.Nil")
    @InlineData("Local")
    @InlineData("Global")
    func NullPattern_DoesNotInvalidateClosureAssignedNarrowing(pattern string) {
        let result = EmittedOracle.Evaluate(`
class C {}
class P { public const Nil C? = nil }
func Read(value object?) int32 {
    const Local C? = nil
    var text string? = "ok"
    let clear = () -> { text = nil }
    if text != nil {
        let matches = value is (PATTERN)
        return text.Length
    }
    return 0
}
const Global C? = nil
Read(nil)
`.Replace("PATTERN", pattern))
        Assert.Empty(result.Diagnostics)
        Assert.Equal("2", result.ValueText)
    }

    @Theory
    @InlineData("P.Nil")
    @InlineData("Local")
    @InlineData("Global")
    func NullPatternInLoop_DoesNotInvalidateClosureAssignedNarrowing(pattern string) {
        let result = EmittedOracle.Evaluate(`
class C {}
class P { public const Nil C? = nil }
func Read(value object?) int32 {
    const Local C? = nil
    var text string? = "ok"
    let clear = () -> { text = nil }
    if text == nil { return 0 }
    for var i = 0; i < 1; i++ {
        let matches = value is (PATTERN)
        return text.Length
    }
    return 0
}
const Global C? = nil
Read(nil)
`.Replace("PATTERN", pattern))
        Assert.Empty(result.Diagnostics)
        Assert.Equal("2", result.ValueText)
    }

    @Fact
    func ConstFunctionLiteral_ConvertedToNamedDelegate_KeepsItsBinding() {
        let result = EmittedOracle.Evaluate(`
delegate D() void;
func Read() int32 {
    var count int32 = 0
    const F D = func() void { count += 1 }
    F()
    return count
}
Read()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("1", result.ValueText)
    }

    @Theory
    @InlineData("cast[object](cast[int32](cast[*int32](nil)))")
    @InlineData("cast[object](cast[nint](cast[*int32](nil)))")
    func BoxedPointerZeroPattern_InvalidatesClosureAssignedNarrowing(pattern string) {
        let result = EmittedOracle.Evaluate(`
unsafe func Read(value object) int32 {
    var text string? = "ok"
    let clear = () -> { text = nil }
    if text != nil {
        let matches = value is (PATTERN)
        return text.Length
    }
    return 0
}
Read(0)
`.Replace("PATTERN", pattern))
        let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0158"))
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData("var p = P.Nil\n        p = replacement\n        let matches = value is (p)")
    @InlineData(
        "var p = P.Nil\n        var copy = p\n        copy = replacement\n        let matches = value is (copy)"
    )
    func ReassignedNullOriginInLoop_InvalidatesClosureAssignedNarrowing(body string) {
        let result = EmittedOracle.Evaluate(`
class C {}
class P { public const Nil C? = nil }
func Read(value object, replacement C) int32 {
    var text string? = "ok"
    let clear = () -> { text = nil }
    if text == nil { return 0 }
    for var i = 0; i < 2; i++ {
        let length = text.Length
        BODY
    }
    return 0
}
Read(C(), C())
`.Replace("BODY", body))
        let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0158"))
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData("MaxValue", "79228162514264337593543950335")
    @InlineData("MinValue", "-79228162514264337593543950335")
    @InlineData("Zero", "0")
    @InlineData("One", "1")
    @InlineData("MinusOne", "-1")
    func ImportedDecimalConstants_Fold(member string, expected string) {
        let result = EmittedOracle.Evaluate("const d decimal = decimal.$member\nd")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    @Theory
    @InlineData("C?", "nil")
    @InlineData("C", "nil")
    @InlineData("C", "default")
    @InlineData("C", "default(C)")
    @InlineData("C?", "default(C?)")
    @InlineData("I?", "nil")
    @InlineData("D?", "nil")
    @InlineData("[]?C", "nil")
    @InlineData("string?", "default(string?)")
    @InlineData("object?", "default(object?)")
    func ReferenceNullConstants_FoldFieldsAndLocals(type string, initializer string) {
        let result = EmittedOracle.Evaluate(`
class C {}
interface I {}
delegate D() void;
class P {
    public const Nil TYPE = INITIALIZER
}
func Read() bool {
    const Local TYPE = P.Nil
    return Local == nil
}
Read()
`.Replace("TYPE", type).Replace("INITIALIZER", initializer))
        Assert.Empty(result.Diagnostics)
        Assert.Equal("True", result.ValueText)
    }

    @Theory
    @InlineData("class C {}\nconst Bad C? = C()", "C()")
    @InlineData("const Bad object? = 42", "42")
    @InlineData("func F() void {\n    const Bad object? = 42\n}\nF()", "42")
    @InlineData("class C {}\nfunc F() void {\n    const Bad C? = C()\n}\nF()", "C()")
    func NonNullReferenceConstant_ReportsGS0376(source string, initializer string) {
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0376"))
        Assert.Equal(initializer, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @InlineData("func Read() int32 {\n    const Nil C = nil\n    return Nil.Number\n}\nRead()")
    @InlineData("func Read() int32 {\n    const Nil C = default\n    return Nil.Number\n}\nRead()")
    @InlineData("func Read() int32 {\n    const Nil C = default(C?) ?? default(C)\n    return Nil.Number\n}\nRead()")
    @InlineData("class P {\n    public const First C = Last\n    public const Last C = nil\n}\nP.First.Number")
    func NullConstants_DoNotEstablishNonNullReceiverTypes(source string) {
        let result = EmittedOracle.Evaluate("class C {\n    prop Number int32 -> 1\n}\n" + source)
        let diagnostic = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0158"))
        Assert.Equal("Number", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }
}

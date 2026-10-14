// <copyright file="Issue1652DefaultValueEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #1652 emitted-session regression coverage. The retired
/// `Evaluator.DefaultValue` only special-cased
/// `bool`/`int32`/`string`/enum/struct and fell back to
/// `null` for every other primitive (int64, the unsigned/sized integer
/// family, float32/float64, decimal, char, nint/nuint) — diverging from the
/// emitted IL. These tests pin the CLR-correct zero for each value type
/// (e.g. `0L` for int64, `0.0` for float64) across
/// map-miss defaults, struct/class field defaults, auto-property defaults,
/// and enum defaults for every affected primitive. A `nil` default would
/// either throw or misbehave in the arithmetic/comparison below, so the exact
/// emitted-session result demonstrates the fix.
open class Issue1652DefaultValueEmittedSessionTests {
    @Theory
    @InlineData("int64", "5")
    @InlineData("uint64", "5")
    @InlineData("uint32", "5")
    @InlineData("int16", "5")
    @InlineData("uint16", "5")
    @InlineData("int8", "5")
    @InlineData("uint8", "5")
    @InlineData("nint", "5")
    @InlineData("nuint", "5")
    func MapMiss_IntegerDefault_AddsAsTypedZero(typeName string, expected string) {
        // Repro from the issue: reading a missing map key must yield the
        // CLR zero for the value type, not `nil` (which would blow up or
        // silently no-op the `+`).
        let source = (`var m = map[string,` + "$typeName" + `]{}
let v = m["missing"]
v + ` + "$typeName" + `(5)`)
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal(expected + Environment.NewLine, output)
    }

    @Fact
    func MapMiss_Float32Default_AddsAsZero() {
        let source = `var m = map[string,float32]{}
let v = m["missing"]
v + float32(1.5)`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("1.5" + Environment.NewLine, output)
    }

    @Fact
    func MapMiss_Float64Default_AddsAsZero() {
        let source = `var m = map[string,float64]{}
let v = m["missing"]
v + 1.5`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("1.5" + Environment.NewLine, output)
    }

    @Fact
    func MapMiss_CharDefault_IsNulChar() {
        // char's CLR default is '\0'; comparing against it must succeed
        // (previously `nil` would fail the comparison / throw).
        let source = `var m = map[string,char]{}
let v = m["missing"]
v == char(0)`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("True" + Environment.NewLine, output)
    }

    @Fact
    func MapMiss_BoolDefault_IsFalse() {
        let source = "var m = map[string,bool]{}\nm[\"missing\"]"
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("False" + Environment.NewLine, output)
    }

    @Fact
    func StructField_Int64Default_AddsAsZero() {
        let source = `struct Counter {
    var Value int64
}
let c = Counter{}
c.Value + int64(7)`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("7" + Environment.NewLine, output)
    }

    @Fact
    func ClassField_Float64Default_AddsAsZero() {
        let source = `class Sample {
    var Amount float64
}
let s = Sample{}
s.Amount + 2.25`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("2.25" + Environment.NewLine, output)
    }

    @Fact
    func AutoProperty_UInt32Default_AddsAsZero() {
        let source = `class Foo {
    prop Count uint32
}
let f = Foo{}
f.Count + uint32(9)`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("9" + Environment.NewLine, output)
    }

    @Fact
    func AutoProperty_CharDefault_IsNulChar() {
        let source = `class Foo {
    prop Letter char
}
let f = Foo{}
f.Letter == char(0)`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("True" + Environment.NewLine, output)
    }

    @Fact
    func UserEnum_DefaultValue_EqualsZeroMember() {
        // default(Color) must equal Color.Red (the first, auto-numbered-0
        // member), not `nil`. (No explicit `package` declaration: the value
        // echo rides the submission's synthesized <Result>$ capture, which
        // lives in the submission's default package — ADR-0156 Phase 3c,
        // #3176.)
        let source = `enum Color { Red, Green, Blue }
class Box {
    var C Color
}
let b = Box{}
b.C == Color.Red`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("True" + Environment.NewLine, output)
    }

    @Fact
    func ImportedEnum_DefaultValue_IsZeroMember() {
        // Imported enums (real CLR System.Enum types, e.g. DayOfWeek) DO
        // have a ClrType, so their default must be a properly-typed boxed
        // enum zero via Enum.ToObject, not a raw int — printing the zero
        // member's name ("Sunday"), and arithmetic off it produces the
        // next real enum member ("Monday"), exactly as compiled code would.
        let source = `import System
struct Meeting {
    var Day DayOfWeek
}
let m = Meeting{}
Console.WriteLine(m.Day)
Console.WriteLine(m.Day + int32(1))`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("Sunday" + Environment.NewLine + "Monday" + Environment.NewLine, output)
        Assert.EndsWith("Monday" + Environment.NewLine, output, StringComparison.Ordinal)
    }

    @Fact
    func NullableInt32Default_IsNilNotZero() {
        // Regression guard: NullableTypeSymbol.ClrType aliases the
        // underlying type's ClrType, so the value-type fallback must not
        // swallow it — default(int32?) is nil, not boxed 0.
        let source = `class Foo {
    var Count int32?
}
let f = Foo{}
f.Count == nil`
        let output = RunSubmission(source)
        Assert.DoesNotContain("error GS", output)
        Assert.Equal("True" + Environment.NewLine, output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString()
        }
    }
}

// <copyright file="Issue1927VarianceConversionAndStringConcatTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #1927 — two distinct bugs, both exercised via the grid app G08
/// generics fixture:
///
/// Bug A: declaration-site variance (`out`/`in`, ADR-0021)
/// was recognized during interface DECLARATION (position checks), but the
/// CONVERSION classifier never consulted it, so a constructed covariant
/// interface (`ISource[string]`) failed to convert to its widened form
/// (`ISource[object]`) with GS0155, and likewise a contravariant
/// interface (`ISink[object]`) failed to narrow to
/// `ISink[string]`.
///
/// Bug B: the binary `+` string-concatenation operator only
/// accepted homogeneous `string + string`; a `string?` operand
/// (e.g. from `T.ToString()` under a `class` constraint, or from
/// `object.ToString()`) triggered GS0129 "'string' + 'string?'".
open class Issue1927VarianceConversionAndStringConcatTests {
    @Fact
    func CovariantOutInterface_StringToObject_ConvertsImplicitly() {
        let source = `
interface ISource[out T] {
    func Get() T;
}

class StringSource : ISource[string] {
    func Get() string { return "made" }
}

var source ISource[string] = StringSource{}
var widened ISource[object] = source
widened.Get().ToString()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("made", result.Value)
    }

    @Fact
    func ContravariantInInterface_ObjectToString_ConvertsImplicitly() {
        let source = `
interface ISink[in T] {
    func Accept(value T) string;
}

class ObjectSink : ISink[object] {
    func Accept(value object) string { return "took:" + value.ToString() }
}

var sink ISink[object] = ObjectSink{}
var narrowed ISink[string] = sink
narrowed.Accept("note")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("took:note", result.Value)
    }

    @Fact
    func InvariantInterface_DifferentArguments_StillDiagnoses() {
        // Guardrail: a type parameter with NO variance modifier must remain
        // invariant even after the variance-conversion fix — the arguments
        // must be identical, not merely convertible.
        let source = `
interface IBox[T] {
    func Get() T;
}

class StringBox : IBox[string] {
    func Get() string { return "x" }
}

var box IBox[string] = StringBox{}
var widened IBox[object] = box
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot convert"))
    }

    @Fact
    func ContravariantInInterface_WrongDirection_StillDiagnoses() {
        // Guardrail: contravariance only permits narrowing (object -> string
        // interface). The reverse (widening an `in`-annotated interface)
        // must still fail.
        let source = `
interface ISink[in T] {
    func Accept(value T) string;
}

class StringSink : ISink[string] {
    func Accept(value string) string { return "got:" + value }
}

var narrow ISink[string] = StringSink{}
var wide ISink[object] = narrow
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot convert"))
    }

    @Fact
    func CovariantOutInterface_Int32ToObject_StillDiagnoses() {
        // Review follow-up (blocking finding on PR #1955): CLR generic-interface
        // variance (ECMA-335 II.9.7) applies only to reference-typed type
        // arguments. `int32` boxes implicitly to `object` (ADR-0045), but that
        // is NOT the same as a variance-compatible reference conversion — the
        // emitter's variance path emits no box/cast, so accepting this would
        // produce unsound IL. Must still fail with GS0155, mirroring C#'s
        // CS0266 rejection of `IEnumerable<int> -> IEnumerable<object>`.
        let source = `
interface ISource[out T] {
    func Get() T;
}

class IntSource : ISource[int32] {
    func Get() int32 { return 1 }
}

var source ISource[int32] = IntSource{}
var widened ISource[object] = source
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot convert"))
    }

    @Fact
    func ContravariantInInterface_ObjectToInt32_StillDiagnoses() {
        // Contravariant equivalent of the guardrail above: narrowing
        // `ISink[object]` to `ISink[int32]` must not be treated as a
        // variance-compatible reference conversion either.
        let source = `
interface ISink[in T] {
    func Accept(value T) string;
}

class ObjectSink : ISink[object] {
    func Accept(value object) string { return value.ToString() }
}

var sink ISink[object] = ObjectSink{}
var narrowed ISink[int32] = sink
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot convert"))
    }

    @Fact
    func CovariantOutInterface_UserStructToObject_StillDiagnoses() {
        // A user-defined generic struct type argument is also a value type
        // and must be excluded from variance eligibility the same way a
        // primitive is.
        let source = `
struct Point {
    var x int32
}

interface ISource[out T] {
    func Get() T;
}

class PointSource : ISource[Point] {
    func Get() Point { return Point{ x: 1 } }
}

var source ISource[Point] = PointSource{}
var widened ISource[object] = source
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot convert"))
    }

    @Fact
    func ClassConstrainedTypeParameter_ToStringConcat_Binds() {
        // Bug B, exact reported shape: `T.ToString()` under a `class`
        // constraint yields `string?`; concatenating it with a `string`
        // literal must not raise GS0129.
        let source = `
func describe[T class](item T) string {
    return "value:" + item.ToString()
}

describe("hello")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("value:hello", result.Value)
    }

    @Theory
    @InlineData(`var s1 string? = "a"
var s2 string? = "b"
s1 + s2`, "ab")
    @InlineData(`var s1 string = "a"
var s2 string? = "b"
s1 + s2`, "ab")
    @InlineData(`var s1 string? = "a"
var s2 string = "b"
s1 + s2`, "ab")
    func StringConcat_AnyNullableCombination_Binds(source string, expected string) {
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

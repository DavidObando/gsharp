// <copyright file="PatternEvaluationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Emitted-oracle coverage for pattern evaluation.
open class PatternEvaluationTests {
    @Fact
    func SwitchExpression_ConstantPattern_Evaluates() {
        AssertEvaluates(`
let v = 1
let x = switch v { case 1: "one" default: "other" }
x
`, "one")
    }

    @Fact
    func SwitchExpression_DiscardPattern_Evaluates() {
        AssertEvaluates(`
let v = true
let x = switch v { case _: 7 }
x
`, 7)
    }

    @Fact
    func SwitchExpression_TypePattern_EvaluatesAndBindsVariable() {
        AssertEvaluates(`
class User { var Name string }
let u = User{Name: "x"}
let x = switch u { case v is User: v.Name default: "n" }
x
`, "x")
    }

    @Fact
    func SwitchExpression_PropertyPattern_Evaluates() {
        AssertEvaluates(`
class User { var Name string var Age int32 }
let u = User{Name: "x", Age: 1}
let x = switch u { case { Name: "x", Age: > 0 }: "hit" default: "miss" }
x
`, "hit")
    }

    @Fact
    func SwitchExpression_RelationalPattern_Evaluates() {
        AssertEvaluates(`
let v = 3
let x = switch v { case > 0: "pos" default: "other" }
x
`, "pos")
    }

    @Fact
    func SwitchExpression_ListPattern_Evaluates() {
        AssertEvaluates(`
let a = []int32{1, 2, 3}
let x = switch a { case [1, _, 3]: "hit" default: "miss" }
x
`, "hit")
    }

    @Fact
    func SwitchStatement_RelationalPattern_Evaluates() {
        AssertEvaluates(`
let v = 2
var x = ""
switch v { case > 0 { x = "pos" } default { x = "other" } }
x
`, "pos")
    }

    @Fact
    func SwitchExpression_SlicePattern_Bookend_Evaluates() {
        AssertEvaluates(`
let a = []int32{1, 9, 9, 9, 3}
let x = switch a { case [1, .., 3]: "bookend" default: "other" }
x
`, "bookend")
    }

    @Fact
    func SwitchExpression_SlicePattern_TooShort_DoesNotMatch() {
        AssertEvaluates(`
let a = []int32{5}
let x = switch a { case [1, .., 3]: "bookend" default: "other" }
x
`, "other")
    }

    @Fact
    func SwitchExpression_SlicePattern_MatchAnyLength_Evaluates() {
        AssertEvaluates(`
let a = []int32{}
let x = switch a { case [..]: "any" default: "other" }
x
`, "any")
    }

    @Fact
    func SwitchExpression_SlicePattern_SuffixBindsElement_Evaluates() {
        AssertEvaluates(`
let a = []int32{100, 200}
let x = switch a { case [.., l is int32]: l default: -1 }
x
`, 200)
    }

    @Fact
    func SwitchExpression_SlicePattern_PrefixBindsElement_Evaluates() {
        AssertEvaluates(`
let a = []int32{42, 1, 2}
let x = switch a { case [f is int32, ..]: f default: -1 }
x
`, 42)
    }

    @Fact
    func SwitchExpression_CapturedSlice_BindsMiddleContents() {
        AssertEvaluates(`
let a = []int32{10, 20, 30, 40}
let x = switch a { case [_, ..rest, _]: rest[0] default: -1 }
x
`, 20)
    }

    @Fact
    func SwitchExpression_CapturedSlice_BindsMiddleLength() {
        AssertEvaluates(`
let a = []int32{10, 20, 30, 40}
let x = switch a { case [_, ..rest, _]: rest.Length default: -1 }
x
`, 2)
    }

    @Fact
    func SwitchExpression_CapturedSlice_EmptyMiddle_BindsEmptySlice() {
        AssertEvaluates(`
let a = []int32{7, 8}
let x = switch a { case [_, ..rest, _]: rest.Length default: -1 }
x
`, 0)
    }

    shared {
        private func AssertEvaluates(source string, expected object) {
            let result = Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(expected, result.Value)
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

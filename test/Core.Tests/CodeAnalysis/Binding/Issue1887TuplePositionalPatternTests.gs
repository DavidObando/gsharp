// <copyright file="Issue1887TuplePositionalPatternTests.cs" company="GSharp">
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

/// Issue #1887: a C# positional pattern over a raw tuple lowers to a G#
/// property pattern keyed on the tuple's Item1..ItemN fields. Previously the
/// property-pattern matcher rejected a ValueTuple subject (GS0172); it now
/// binds, emits, and evaluates against tuple element fields.
open class Issue1887TuplePositionalPatternTests {
    @Fact
    func SwitchExpression_TuplePropertyPattern_MatchesFirstArm() {
        AssertEvaluates(`
let p = (0, 0)
let x = switch p { case { Item1: 0, Item2: 0 }: "origin" default: "other" }
x
`, "origin")
    }

    @Fact
    func SwitchExpression_TuplePropertyPattern_FallsThroughToDefault() {
        AssertEvaluates(`
let p = (3, 4)
let x = switch p { case { Item1: 0, Item2: 0 }: "origin" default: "other" }
x
`, "other")
    }

    @Fact
    func SwitchExpression_TuplePropertyPattern_RelationalSubpattern() {
        AssertEvaluates(`
let p = (3, 4)
let x = switch p { case { Item1: 0, Item2: 0 }: "origin" case { Item1: > 0, Item2: > 0 }: "ne" default: "other" }
x
`, "ne")
    }

    @Fact
    func SwitchExpression_TuplePropertyPattern_DiscardSubpattern() {
        AssertEvaluates(`
let p = (0, 7)
let x = switch p { case { Item1: 0, Item2: 0 }: "origin" case { Item1: 0, Item2: _ }: "y-axis" default: "other" }
x
`, "y-axis")
    }

    @Fact
    func SwitchExpression_TuplePropertyPattern_ArityThree() {
        AssertEvaluates(`
let p = (0, 0, 5)
let x = switch p { case { Item1: 0, Item2: 0, Item3: 5 }: "hit" default: "miss" }
x
`, "hit")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func AssertEvaluates(source string, expected object) {
            let result = Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(expected, result.Value)
        }
    }
}

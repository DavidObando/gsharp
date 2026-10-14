// <copyright file="Issue714LambdaBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #714 / ADR-0074 — binder and end-to-end coverage for the new
/// arrow-lambda expression form and the deprecated switch-arm arrow
/// (GS0302) warning.
open class Issue714LambdaBinderTests {
    @Fact
    func Lambda_ZeroArgInvocation_ProducesExpectedValue() {
        let result = Evaluate(`
let f = () -> 42
f()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Lambda_TypedParameter_AndExpressionBody_ReturnsValue() {
        let result = Evaluate(`
let inc = (x int32) -> x + 1
inc(41)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Lambda_TypedParameters_AndExpressionBody_ReturnsValue() {
        let result = Evaluate(`
let add = (a int32, b int32) -> a + b
add(20, 22)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Lambda_BlockBody_TrailingExpressionIsValue() {
        let result = Evaluate(`
let f = (x int32) -> {
  let y = x * 2
  y + 2
}
f(20)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Lambda_CapturesOuterLocal() {
        let result = Evaluate(`
let base = 40
let f = (x int32) -> x + base
f(2)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func SwitchExpression_ColonArm_BindsCleanly_NoWarnings() {
        let result = Evaluate(`
let n = 1
let s = switch n {
  case 0: "zero"
  default: "other"
}
s
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("other", result.Value)
    }

    @Fact
    func SwitchExpression_ArrowArm_EmitsGs0302_StillEvaluates() {
        let result = Evaluate(`
let n = 0
let s = switch n {
  case 0 -> "zero"
  default -> "other"
}
s
`)
        let warnings = result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0302").ToList()
        Assert.Equal(2, warnings.Count)
        Assert.All(warnings, (w Diagnostic) -> Assert.False(w.IsError))
        // The non-warning diagnostics should be empty (i.e. the program still
        // binds and emits cleanly past the deprecation warning).
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("zero", result.Value)
    }

    @Fact
    func SwitchExpression_MixedArmSeparators_OnlyArrowsWarn() {
        let result = Evaluate(`
let n = 1
let s = switch n {
  case 0: "zero"
  case 1 -> "one"
  default: "other"
}
s
`)
        let warnings = result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0302").ToList()
        Assert.Single(warnings)
        Assert.Equal("one", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

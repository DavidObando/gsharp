// <copyright file="Issue1278ArrowExpressionMemberTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #1278: Emitted-oracle coverage for arrow expression member.
/// Traceability: ADR-0131.
open class Issue1278ArrowExpressionMemberTests {
    @Fact
    func FunctionArrowBody_BindsAndEvaluates() {
        let source = `
func square(x int32) int32 -> x * x

var r = square(7)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(49, result.Value)
    }

    @Fact
    func Issue3375_TupleReturningArrowBody_BindsAndEvaluates() {
        let source = `
class PairFactory {
    shared {
        private func Pair() (int32, int32) -> (1, 2)
        func Sum() int32 {
            let pair = Pair()
            return pair.Item1 * 10 + pair.Item2
        }
    }
}

var r = PairFactory.Sum()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func ReadOnlyPropertyArrow_BindsAndEvaluates() {
        let source = `
class Box {
    var seed int32
    prop Doubled int32 -> this.seed * 2
}

var b = Box()
b.seed = 21
var r = b.Doubled
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func AccessorArrows_RoundTripThroughField() {
        let source = `
class Box {
    var n int32
    prop Value int32 {
        get -> this.n
        set -> this.n = value
    }
}

var b = Box()
b.Value = 17
var r = b.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(17, result.Value)
    }

    @Fact
    func ConversionOperatorArrow_BindsAndEvaluates() {
        let source = `
struct Celsius {
    var degrees int32
}

func operator implicit (c Celsius) int32 -> c.degrees

var c = Celsius{degrees: 36}
var d int32 = c
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(36, result.Value)
    }

    @Fact
    func TypeErrorInArrowBody_IsReported() {
        // The desugared body type-checks exactly like a block body: a string
        // expression cannot satisfy an int32 return type.
        let source = `
func bad(x int32) int32 -> "nope"

var r = bad(1)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

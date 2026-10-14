// <copyright file="Issue2616CharNumericPromotionEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2616: Emitted-oracle coverage for char numeric promotion.
open class Issue2616CharNumericPromotionEmittedOracleTests {
    @Fact
    func UnaryBinaryAndCompoundCharArithmetic_EvaluatesPromotedValues() {
        const Source = `var a char = '5'
var b char = '1'
var difference = a - b
var unary = -a + ~b + +a
var value char = 'A'
value += 2
var lifted char? = 'C'
lifted -= 'A'`
        let result = EmittedOracle.Evaluate(Source)
        let Value = func (name string) object? {
            return result.ReadGlobal(name)
        }
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, Value("difference"))
        Assert.Equal(-int32('5') + ~int32('1') + int32('5'), Value("unary"))
        Assert.Equal('C', Value("value"))
        Assert.Equal(char(2), Value("lifted"))
    }

    @Fact
    func CheckedLiftedCharCompound_ThrowsOnNarrowingOverflow() {
        const Source = `var value char? = 'A'
var narrowingCaught = "no"
var operatorCaught = "no"
var decimalCaught = "no"
checked {
    try {
        value += 65536
    } catch (e OverflowException) {
        narrowingCaught = "yes"
    }
    try {
        value += uint32(4294967295)
    } catch (e OverflowException) {
        operatorCaught = "yes"
    }
    try {
        value += decimal(65536)
    } catch (e OverflowException) {
        decimalCaught = "yes"
    }
}`
        let result = EmittedOracle.Evaluate(Source)
        let Value = func (name string) object? {
            return result.ReadGlobal(name)
        }
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", Value("narrowingCaught"))
        Assert.Equal("yes", Value("operatorCaught"))
        Assert.Equal("yes", Value("decimalCaught"))
    }
}

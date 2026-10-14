// <copyright file="ClrOperatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit

/// Stream C — user-defined operators on imported CLR types. Verifies that
/// binary and unary operators on types such as (cref:TimeSpan) and
/// (cref:DateTime) resolve to their `op_*` static methods through
/// the shared overload-resolution pipeline.
open class ClrOperatorTests {
    @Fact
    func TimeSpanAddition_Binds_AndProduces_TimeSpan() {
        let source = `
import System

var a = TimeSpan(0, 0, 30)
var b = TimeSpan(0, 0, 15)
var c = a + b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.IsType[TimeSpan](result.Value)
        Assert.Equal(TimeSpan.FromSeconds(45), result.Value)
    }

    @Fact
    func TimeSpanSubtraction_Binds() {
        let source = `
import System

var a = TimeSpan(0, 0, 30)
var b = TimeSpan(0, 0, 15)
var c = a - b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(TimeSpan.FromSeconds(15), result.Value)
    }

    @Fact
    func TimeSpanUnaryNegation_Binds() {
        let source = `
import System

var a = TimeSpan(0, 0, 30)
var b = -a
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(TimeSpan.FromSeconds(-30), result.Value)
    }

    @Fact
    func TimeSpanEquality_Binds() {
        let source = `
import System

var a = TimeSpan(0, 0, 30)
var b = TimeSpan(0, 0, 30)
var c = a == b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DateTimeMinusTimeSpan_Binds() {
        // Verifies cross-operand resolution: op_Subtraction declared on
        // DateTime accepts (DateTime, TimeSpan) and returns DateTime.
        let source = `
import System

var dt = DateTime(2025, 1, 2)
var span = TimeSpan(1, 0, 0, 0)
var earlier = dt - span
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(DateTime(2025, 1, 1), result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

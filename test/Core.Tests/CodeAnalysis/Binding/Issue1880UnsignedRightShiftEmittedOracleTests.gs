// <copyright file="Issue1880UnsignedRightShiftEmittedOracleTests.cs" company="GSharp">
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

/// Issue #1880: Emitted-oracle coverage for unsigned right shift.
open class Issue1880UnsignedRightShiftEmittedOracleTests {
    @Fact
    func SByte_NegativeOne_UnsignedShiftRight_MatchesCompiledIl() {
        let result = Evaluate("var v sbyte = -1\nv >>> 1")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int8(-1), result.Value)
    }

    @Fact
    func Short_NegativeOne_UnsignedShiftRight_MatchesCompiledIl() {
        let result = Evaluate("var v short = -1\nv >>> 1")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int16(-1), result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

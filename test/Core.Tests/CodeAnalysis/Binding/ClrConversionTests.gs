// <copyright file="ClrConversionTests.cs" company="GSharp">
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
import System.Numerics
import Xunit

/// Stream E — user-defined / imported CLR conversion operators
/// (`op_Implicit`, `op_Explicit`) participate in
/// `BindConversion` after built-in conversions fail.
open class ClrConversionTests {
    @Fact
    func DateTimeToDateTimeOffset_ImplicitConversion_Succeeds() {
        // DateTimeOffset declares public static op_Implicit(DateTime).
        let source = `
import System

var dt = DateTime(2025, 6, 1)
var dto DateTimeOffset = dt
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.IsType[DateTimeOffset](result.Value)
        Assert.Equal(DateTime(2025, 6, 1), (DateTimeOffset(result.Value)).DateTime)
    }

    @Fact
    func IntToBigInteger_ImplicitConversion_Succeeds() {
        // BigInteger declares public static op_Implicit(Int32).
        let source = `
import System.Numerics

var x BigInteger = 12345
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(BigInteger.Parse("12345"), result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

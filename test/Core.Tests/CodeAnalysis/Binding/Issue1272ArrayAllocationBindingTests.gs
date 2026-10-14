// <copyright file="Issue1272ArrayAllocationBindingTests.cs" company="GSharp">
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
import System.Collections.Immutable
import Xunit

/// Issue #1272: Emitted-oracle coverage for array allocation binding.
open class Issue1272ArrayAllocationBindingTests {
    @Fact
    func ConstantLength_ZeroInitialised() {
        let result = Evaluate("var xs = [3]int32\nxs[0] + xs[1] + xs[2]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func RuntimeLength_AllElementsZero() {
        let result = Evaluate(`let n = 4
var xs = [n]int32
xs.Length + xs[0] + xs[3]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func EmptyInitializerSpelling_ZeroInitialised() {
        let result = Evaluate(`let n = 2
var xs = [n]int32{}
xs.Length + xs[0] + xs[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func RuntimeLength_MutationReadBack() {
        let result = Evaluate(`let n = 3
var xs = [n]int32
xs[1] = 42
xs[0] + xs[1] + xs[2]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func RuntimeLength_ResultIsSlice() {
        let result = Evaluate(`let n = 5
var xs = [n]int32
xs.Length`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func LiteralFormUnchanged_LengthMismatchReportsGs0115() {
        let diagnostics = Bind("var xs = [5]int32{1, 2, 3}\n")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0115")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] -> Evaluate(source).Diagnostics
    }
}

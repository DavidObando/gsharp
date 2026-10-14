// <copyright file="Issue2553RepeatedDiscardRuntimeTests.cs" company="GSharp">
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

open class Issue2553RepeatedDiscardRuntimeTests {
    @Fact
    func RepeatedDiscards_PreserveValuesAndEvaluateAssignmentRightHandSides() {
        const source = `var calls = 0
let (kept, _, _) = (10, 20, 30)
var assigned = 0
assigned, _, _ = ++calls, ++calls, ++calls
var loopTotal = 0
for (first, _, _) in [2](int32, int32, int32){(2, 20, 200), (3, 30, 300)} {
    loopTotal = loopTotal + first
}
kept + assigned + calls + loopTotal`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(19, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

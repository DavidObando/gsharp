// <copyright file="Issue1246CompoundAssignWideningEmittedOracleTests.cs" company="GSharp">
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

/// Issue #1246: Emitted-oracle coverage for compound assign widening.
open class Issue1246CompoundAssignWideningEmittedOracleTests {
    @Fact
    func Int32PlusEqualsUInt8_EvaluatesWidenedSum() {
        let source = `
var a int32 = 200
var b uint8 = 100
a += b
`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(300, vars["a"])
    }

    @Fact
    func Int64PlusEqualsInt32_EvaluatesWidenedSum() {
        let source = `
var acc int64 = 4000000000
var i int32 = 1
acc += i
`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(4000000001L, vars["acc"])
    }

    @Fact
    func Int64PlusEqualsIntLiteral_EvaluatesSum() {
        let source = `
var x int64 = 4000000000
x += 1
`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(4000000001L, vars["x"])
    }

    shared {
        private func EvaluateWithVariables(source string)(
            Result EmittedOracleResult,
            Variables IReadOnlyDictionary[string, object?]
        ) {
            // Post-run globals read back through the oracle (issue #3176 Phase
            // 3b.2): the emitted equivalent of the evaluator's variables
            // dictionary.
            let result = EmittedOracle.Evaluate(source)
            return (result, result.ReadGlobals())
        }
    }
}

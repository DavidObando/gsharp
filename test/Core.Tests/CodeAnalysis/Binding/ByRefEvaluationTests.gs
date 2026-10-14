// <copyright file="ByRefEvaluationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import System.Collections.Generic
import Xunit

/// ADR-0039: by-ref/out write-back semantics, asserted through the emitted
/// oracle. The interpreter pointer-model pin
/// (`AddressOf_Evaluates_To_Value_In_Interpreter`, "&x evaluates to
/// the value") retired with the tree-walking evaluator in ADR-0156 Phase 3c
/// (#3176) — it asserted ADR-0039's interpreter-only by-design behavior,
/// which has no emitted equivalent (under emit the byref-typed local never
/// surfaces as a readable global, see #3215).
open class ByRefEvaluationTests {
    @Fact
    func IntTryParse_Success_WritesBack_Result() {
        let source = `
import System
var result = 0
var ok = Int32.TryParse("42", &result)
`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(true, vars["ok"])
        Assert.Equal(42, vars["result"])
    }

    @Fact
    func IntTryParse_Failure_WritesBack_Zero() {
        let source = `
import System
var result = 99
var ok = Int32.TryParse("notanumber", &result)
`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(false, vars["ok"])
        Assert.Equal(0, vars["result"])
    }

    @Fact
    func Dereference_Returns_Original_Value() {
        // #3215 (fixed): the byref-typed `p` stays an entry-point local under
        // emit while `x` and `y` still hoist, so the dereference round-trip
        // is observable through the emitted globals.
        let source = `
var x = 100
var p = &x
var y = *p
`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(100, vars["y"])
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

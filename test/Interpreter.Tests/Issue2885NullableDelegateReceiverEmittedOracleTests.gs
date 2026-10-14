// <copyright file="Issue2885NullableDelegateReceiverEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2885: Emitted-oracle coverage for nullable delegate receiver.
open class Issue2885NullableDelegateReceiverEmittedOracleTests {
    @Fact
    func GuardedNullableFunctionInvokesInWhile() {
        const source = `var result = 0
let write = (value int32) -> { result = value }
var handler ((int32) -> void)? = write
while handler != nil {
    handler(42)
    break
}

result`
        AssertEvaluates(source, 42)
    }

    @Fact
    func GuardedNullableFunctionInvokesInForClause() {
        const source = `var result = 0
let write = (value int32) -> { result = value }
var handler ((int32) -> void)? = write
for var i = 0; handler != nil && i < 1; i++ {
    handler(43)
}

result`
        AssertEvaluates(source, 43)
    }

    shared {
        private func AssertEvaluates(source string, expected int32) {
            let evaluation = EmittedOracle.Evaluate(source)
            Assert.Empty(evaluation.Diagnostics)
            Assert.Equal(expected, evaluation.Value)
        }
    }
}

// <copyright file="Issue2854TopLevelEllipsisLoopCaptureEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2854: Emitted-oracle coverage for top level ellipsis loop capture.
open class Issue2854TopLevelEllipsisLoopCaptureEmittedOracleTests {
    @Fact
    func TopLevelClosureCapturesIterationVariable() {
        AssertEvaluates(`var callback = () -> { return -1 }

for i in 0 ... 1 {
    callback = () -> { return i }
}

let result = callback()
result`, expected: 0)
    }

    @Fact
    func TopLevelForInCapturedWriteUsesSharedCell() {
        AssertEvaluates(`var source = []int32{7, 8}
var total = 0
for value in source {
    var bump = () -> { value = value + 100 }
    bump()
    total = total + value
}

total`, expected: 215)
    }

    shared {
        private func AssertEvaluates(source string, expected int32) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(expected, result.Value)
        }
    }
}

// <copyright file="Issue2853EllipsisLoopCaptureEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2853: Emitted-oracle coverage for ellipsis loop capture.
open class Issue2853EllipsisLoopCaptureEmittedOracleTests {
    @Fact
    func ClosureCapturesValueFromCreatingIteration() {
        AssertEvaluates(`func capture() int32 {
    var callback = () -> { return -1 }

    for i in 0 ... 3 {
        if i == 0 { callback = () -> { return i } }
    }

    return callback()
}

capture()`, expected: 0)
    }

    @Fact
    func CapturedWriteAdvancesLoopControlVariable() {
        AssertEvaluates(`func countIterations() int32 {
    var iterations = 0
    for i in 0 ... 5 {
        var bump = () -> { i = i + 1 }
        bump()
        iterations = iterations + 1
    }

    return iterations
}

countIterations()`, expected: 3)
    }

    @Fact
    func CapturedFunctionLocalWritesSharedCell() {
        AssertEvaluates(`func mutate() int32 {
    var value = 20
    var bump = () -> { value = value + 1 }
    bump()
    return value
}

mutate()`, expected: 21)
    }

    @Fact
    func CapturedIndexWritesUseExpressionTargets() {
        AssertEvaluates(`import System.Collections.Generic

func mutate() int32 {
    var slice = []int32{1}
    var values = map[string,int32]{"x": 2}
    var list = List[int32]()
    list.Add(3)
    var read = () -> { return slice[0] + values["x"] + list[0] }

    slice[0] = 40
    values["x"] = 50
    list[0] = 60
    return slice[0] + values["x"] + list[0] + read()
}

mutate()`, expected: 300)
    }

    @Fact
    func CapturedInstanceFieldWritesUseExpressionReceivers() {
        AssertEvaluates(`class Counter {
    var Value int32
}

struct Pair {
    var Value int32
}

func mutate() int32 {
    var counter = Counter()
    counter.Value = 5
    var readCounter = () -> { return counter.Value }

    var pair = Pair{Value: 1}
    var readPair = () -> { return pair.Value }
    pair.Value = 6

    return counter.Value + readCounter() + pair.Value + readPair()
}

mutate()`, expected: 22)
    }

    @Fact
    func CapturedRefOutAndAliasWritesUseCallerCell() {
        AssertEvaluates(`func addOne(ref value int32) {
    value = value + 1
}

func setSeven(out value int32) {
    value = 7
}

func mutate() int32 {
    var n = 1
    var readN = () -> { return n }
    let ref alias = n
    alias = alias + 1
    addOne(ref n)

    var m = 0
    var readM = () -> { return m }
    setSeven(out m)

    return n * 1000 + readN() * 100 + m * 10 + readM()
}

mutate()`, expected: 3377)
    }

    @Fact
    func CapturedNilClassFieldWriteReportsDiagnostic() {
        const Source = `class Counter {
    var Value int32
}

func mutate() int32 {
    var counter Counter? = Counter()
    var read = () -> { return counter!!.Value }
    counter = nil
    counter!!.Value = 5
    return read()
}

mutate()`
        let result = EmittedOracle.Evaluate(Source)
        Assert.Contains(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS9999")
    }

    shared {
        private func AssertEvaluates(source string, expected int32) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(expected, result.Value)
        }
    }
}

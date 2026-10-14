// <copyright file="Issue3501YieldBreakTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501 Track A1: `yield break` terminates an iterator from any
/// nesting depth (C# alignment). Plain `break` keeps its loop binding;
/// the iterator MoveNext builders already lowered an expressionless return
/// to the shared end label, so `yield break` binds to exactly that.
open class Issue3501YieldBreakTests {
    @Fact
    func YieldBreak_AtBodyLevel_StopsIteration() {
        let source = `
func Items(stop bool) sequence[int32] {
    yield 1
    if stop {
        yield break
    }
    yield 2
}

var total = 0
for _, v in Items(true) {
    total += v
}
for _, v in Items(false) {
    total += v
}
total
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(4, result.Value)
    }

    @Fact
    func YieldBreak_InsideLoop_TerminatesWholeIterator() {
        let source = `
func Items(limit int32) sequence[int32] {
    for var i = 0; i < 10; i += 1 {
        if i >= limit {
            yield break
        }
        yield i
    }
    yield 99
}

var total = 0
for _, v in Items(3) {
    total += v
}
total
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(3, result.Value)
    }

    @Fact
    func PlainBreak_InsideLoop_KeepsLoopBinding() {
        let source = `
func Items(limit int32) sequence[int32] {
    for var i = 0; i < 10; i += 1 {
        if i >= limit {
            break
        }
        yield i
    }
    yield 99
}

var total = 0
for _, v in Items(3) {
    total += v
}
total
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(102, result.Value)
    }

    @Fact
    func YieldBreak_InsideTryFinally_RunsFinally() {
        let source = `
class Probe {
    shared {
        var Cleaned bool = false
    }
}

func Items() sequence[int32] {
    try {
        yield 1
        yield break
    } finally {
        Probe.Cleaned = true
    }
}

var total = 0
for _, v in Items() {
    total += v
}
if Probe.Cleaned {
    total += 10
}
total
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(11, result.Value)
    }

    @Fact
    func YieldBreak_OutsideIterator_ReportsDiagnostic() {
        let source = `
func NotIterator() int32 {
    yield break
    return 1
}
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }
}

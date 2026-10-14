// <copyright file="Issue1922TupleForInStatementTests.cs" company="GSharp">
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

/// Issue #1922: cs2gs lowered a C# `foreach (var (a, b) in list)` over a
/// `List<(T1, T2)>` to `for tmp in list { let (a, b) = tmp ... }`,
/// which failed `GS0164` because the loop element's static type — a
/// CLR `System.ValueTuple<...>` reached via reflection (the
/// element type of an imported generic collection), not a G# tuple-literal
/// parse — surfaced as a plain (cref:ImportedTypeSymbol) rather than
/// (cref:TupleTypeSymbol). Covers both halves of the fix: (1)
/// `let (a, b) = expr` deconstruction now accepts that CLR-shaped
/// tuple, and (2) G#'s new first-class `for (a, b) in coll` loop header.
open class Issue1922TupleForInStatementTests {
    @Fact
    func LetDeconstruction_AcceptsValueTupleElementFromClrListIteration() {
        // Reproduces the exact shape cs2gs used to hand-emit: a hidden
        // single-var loop over `List[(string, int32)]` whose element type is
        // resolved through the CLR-generic-argument path (not a G# tuple
        // literal), then deconstructed via `let`.
        let source = `
import System.Collections.Generic

var list = List[(string, int32)]()
list.Add(("alice", 1))
list.Add(("bob", 2))

var total = 0
for tmp in list {
    let (name, score) = tmp
    total = total + score
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1 + 2, result.Value)
    }

    @Fact
    func ForTupleIn_DeconstructsListOfValueTuples() {
        let source = `
import System.Collections.Generic

var list = List[(string, int32)]()
list.Add(("alice", 1))
list.Add(("bob", 2))

var total = 0
for (name, score) in list {
    total = total + score
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1 + 2, result.Value)
    }

    @Fact
    func ForTupleIn_DeconstructsArrayOfTupleLiterals() {
        // Also exercise the indexed (array) iteration strategy, not just the
        // CLR-enumerable one, since `BindForTupleRangeStatementCore` reuses
        // the shared `BindForRangeStatementCore` dispatch for both.
        let source = `
var pairs = [2](int32, int32){(1, 2), (3, 4)}

var total = 0
for (a, b) in pairs {
    total = total + a + b
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1 + 2 + 3 + 4, result.Value)
    }

    @Fact
    func ForTupleIn_ArityMismatch_ReportsGS0163() {
        let source = `
var pairs = [2](int32, int32){(1, 2), (3, 4)}

for (a, b, c) in pairs {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0163")
    }

    @Fact
    func ForTupleIn_NonTupleElement_ReportsGS0164() {
        let source = `
var xs = [3]int32{1, 2, 3}

for (a, b) in xs {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0164")
    }

    @Fact
    func ForTupleIn_Labeled_BreakByLabelExitsLoop() {
        let source = `
var pairs = [3](int32, int32){(1, 2), (3, 4), (5, 6)}

var seen = 0
outer: for (a, b) in pairs {
    if a == 3 {
        break outer
    }

    seen = seen + 1
}
seen
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func ForTupleIn_ParsesAsForTupleRangeStatement() {
        const source = `
package p
class C { func F(xs [](int32, int32)) { for (a, b) in xs { } } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

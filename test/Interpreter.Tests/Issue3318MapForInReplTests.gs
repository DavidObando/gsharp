// <copyright file="Issue3318MapForInReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import Xunit

/// Issue #3318: range-`for` over `map[K, V]` through the session
/// engine — same-cell, and cross-cell over a map global declared in a prior
/// cell (the submission-hoisted global path). The two-variable form
/// destructures entries into `K`/`V`; the single-variable form
/// yields `KeyValuePair[K, V]`. Pre-fix both forms failed with GS0116.
class Issue3318MapForInReplTests {
    @Fact
    func SameCell_TwoVar_MapIteration_Sums_Keys_And_Values() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(`var m = map[int32, int32]{1: 10, 2: 20}
var total = 0
for k, v in m {
    total = total + k * 100 + v
}
total`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(330, result.Value)
    }

    @Fact
    func SameCell_OneVar_MapIteration_Yields_KeyValuePair() {
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(`var m = map[string, int32]{"a": 1, "bb": 2}
var total = 0
for kv in m {
    total = total + kv.Key.Length * kv.Value
}
total`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(5, result.Value)
    }

    @Fact
    func CrossCell_TwoVar_Iterates_PriorCell_Map_Global() {
        using let engine = EmittedSessionEngine()
        let declare = engine.Evaluate("var scores = map[string, int32]{\"a\": 1, \"b\": 2, \"c\": 3}")
        Assert.False(declare.HasError, string.Join("; ", declare.Diagnostics))
        let iterate = engine.Evaluate(`var sum = 0
for name, score in scores {
    sum = sum + score
}
sum`)
        Assert.False(iterate.HasError, string.Join("; ", iterate.Diagnostics))
        Assert.Equal(6, iterate.Value)
    }

    @Fact
    func CrossCell_OneVar_Iterates_PriorCell_Map_Global() {
        using let engine = EmittedSessionEngine()
        let declare = engine.Evaluate("var m = map[int32, string]{7: \"abc\", 8: \"d\"}")
        Assert.False(declare.HasError, string.Join("; ", declare.Diagnostics))
        let iterate = engine.Evaluate(`var n = 0
for kv in m {
    n = n + kv.Key + kv.Value.Length
}
n`)
        Assert.False(iterate.HasError, string.Join("; ", iterate.Diagnostics))
        Assert.Equal(19, iterate.Value)
    }

    @Fact
    func CrossCell_MapMutated_In_Between_Iterates_Current_State() {
        using let engine = EmittedSessionEngine()
        let declare = engine.Evaluate("var m = map[string, int32]{\"a\": 1}")
        Assert.False(declare.HasError, string.Join("; ", declare.Diagnostics))
        let mutate = engine.Evaluate("m[\"b\"] = 41")
        Assert.False(mutate.HasError, string.Join("; ", mutate.Diagnostics))
        let iterate = engine.Evaluate(`var sum = 0
for k, v in m {
    sum = sum + v
}
sum`)
        Assert.False(iterate.HasError, string.Join("; ", iterate.Diagnostics))
        Assert.Equal(42, iterate.Value)
    }
}

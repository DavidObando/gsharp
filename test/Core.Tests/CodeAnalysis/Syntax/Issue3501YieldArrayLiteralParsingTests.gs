// <copyright file="Issue3501YieldArrayLiteralParsingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501: the contextual-`yield` dispatch rejects a following
/// `[` so that `yield[i]` stays an index into a variable named
/// `yield` — but an empty bracket pair can only begin an array-literal
/// type, so `yield []T{…}` must parse as a yield statement.
open class Issue3501YieldArrayLiteralParsingTests {
    @Fact
    func YieldArrayLiteral_ParsesAsYieldStatement() {
        let source = `
func G() sequence[[]int32] {
    yield []int32{1, 2}
    yield []int32{3}
}

var total = 0
for xs in G() {
    for x in xs {
        total = total + x
    }
}
total
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(6, result.Value)
    }

    @Fact
    func IndexingAVariableNamedYield_StaysAnExpressionStatement() {
        let source = `
let yield = []int32{7, 8}
yield[1]
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(8, result.Value)
    }
}

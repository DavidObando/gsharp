// <copyright file="RefLocalAliasingTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #491 (ADR-0060 follow-up): binder-level tests for ref-aliasing locals
/// declared with `let ref` / `var ref`. Validates lvalue RHS, escape-scope
/// classification (top-level rejection; async/iterator rejection is now the
/// per-suspension-point liveness check added by issue #4222 — see
/// Issue4222RefAliasSuspensionLivenessTests), `const ref` rejection,
/// type-clause mismatch reporting, and clean binding of the canonical shapes from
/// the issue (array element alias, field alias).
open class RefLocalAliasingTests {
    @Fact
    func LetRef_AliasingArrayElement_BindsCleanly() {
        let source = `
func tweak() {
    var arr = []int32{10, 20, 30}
    let ref m = arr[1]
    m = 99
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func VarRef_AliasingStructField_BindsCleanly() {
        let source = `
struct Counter {
    var Value int32
}

func tweak() {
    var c Counter = Counter{Value: 5}
    var ref v = c.Value
    v = v + 1
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func LetRef_WithExplicitTypeClause_BindsCleanly() {
        let source = `
func tweak() {
    var x int32 = 7
    let ref m int32 = x
    m = 8
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func LetRef_FromEndIndex_BindsCleanly() {
        // Issue #3247: `xs[^1]` binds as a BoundBlockExpression (receiver +
        // offset spilled into temps); the ref-alias binder must sink the
        // address-of onto the trailing element access instead of wrapping the
        // block (which ICEd the emitter with GS9998).
        let source = `
func tweak() {
    var arr = []int32{10, 20, 30}
    let ref m = arr[^1]
    m = 99
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func LetRef_FromEndIndexOnString_ReportsGS0256() {
        // Issue #3247: a string's from-end element access lowers to the CLR
        // counted indexer (get_Chars), which is not an lvalue — diagnostic,
        // never an ICE.
        let source = `
func tweak() {
    var s = "abc"
    let ref c = s[^1]
    c = 'z'
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0256")
    }

    @Fact
    func LetRef_FromEndIndexOnMap_ReportsGS0116() {
        // Issue #3247: a map has no length-based element order, so `m[^1]` is
        // not indexable by System.Index — diagnostic, never an ICE.
        let source = `
func tweak() {
    var m = map[string,int32]{"a": 1}
    let ref v = m[^1]
    v = 2
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0116")
    }

    @Fact
    func LetRef_NonLvalueRhs_ReportsGS0256() {
        let source = `
func tweak() {
    let ref m = 1 + 2
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0256")
    }

    @Fact
    func LetRef_LiteralRhs_ReportsGS0256() {
        let source = `
func tweak() {
    let ref m = 42
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0256")
    }

    @Fact
    func LetRef_AliasReadOnlyLetLocal_RejectedAsAddressOfConstant() {
        let source = `
func tweak() {
    let x = 7
    let ref m = x
}
tweak()
0
`
        let result = Evaluate(source)
        // Same diagnostic family as `&x` over a `let` binding (GS9005): cannot take address of constant.
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9005")
    }

    @Fact
    func LetRef_AtTopLevel_ReportsGS0258() {
        let source = `
var n int32 = 7
let ref m = n
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    // Issue #4222: the coarse "no ref alias anywhere in an async function"
    // rule is replaced by per-local liveness (mirroring issue #2350's
    // treatment of by-ref-like locals) — an alias that never crosses a
    // suspension point is fine even though its enclosing function is async.
    // See Issue4222AsyncIteratorRefAliasLivenessTests for the cross-suspension
    // negative controls that still report GS0258.
    @Fact
    func LetRef_InAsyncFunction_NotLiveAcrossAwait_BindsCleanly() {
        let source = `
async func tweak() {
    var n int32 = 7
    let ref m = n
    m = 9
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ConstRef_Rejected() {
        let source = `
func tweak() {
    var n int32 = 7
    const ref m = n
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0258")
    }

    @Fact
    func LetRef_TypeMismatch_ReportsCannotConvert() {
        let source = `
func tweak() {
    var n int32 = 7
    let ref m int64 = n
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0155" ||
                d.Id == "GS0017" ||
                d.Id == "GS0011" ||
                d.Id == "GS0030" ||
                d.Id == "GS0019"
        )
    }

    @Fact
    func LetRef_BindRefAliasOfDereference_BindsCleanly() {
        let source = `
func tweak() {
    var n int32 = 5
    var p *int32 = &n
    let ref m = *p
    m = 11
}
tweak()
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

// <copyright file="Issue3310MagicTypeNilCompareEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #3310 / ADR-0159, nil-comparison half: `x == nil` /
/// `x != nil` binds for EVERY reference-backed magic type. #3309 added
/// maps; this adds slices (`[]T`), fixed arrays (`[N]T`), and
/// channels (`chan[T]`), flipping #3309's deliberate-rejection pins.
/// Matrix per kind: both operators, both operand orders (#3217 nil-on-left
/// canonicalization), plus the open-generic (null-ClrType) field shape.
/// Comparison-only semantics are pinned: bare-slot nil ASSIGNMENT still
/// requires the (not-yet-expressible-for-these-kinds) `?` spelling per
/// ADR-0104, so `s = nil` / `c = nil` stay errors.
open class Issue3310MagicTypeNilCompareEmitTests {
    @Theory
    @InlineData("s != nil", true)
    @InlineData("s == nil", false)
    @InlineData("nil != s", true)
    @InlineData("nil == s", false)
    func SliceNilComparison_BothOperators_BothOrders(probe string, expected bool) {
        let result = EmittedOracle.Evaluate((`package P3310SliceNil

var s = []int32{1}
` + "$probe"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(expected, result.Value)
    }

    @Theory
    @InlineData("c != nil", true)
    @InlineData("c == nil", false)
    @InlineData("nil != c", true)
    @InlineData("nil == c", false)
    func ChannelNilComparison_BothOperators_BothOrders(probe string, expected bool) {
        let result = EmittedOracle.Evaluate((`package P3310ChanNil


var c = chan[int32](1)
` + "$probe"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(expected, result.Value)
    }

    @Theory
    @InlineData("a != nil", true)
    @InlineData("a == nil", false)
    func FixedArrayNilComparison_BothOperators(probe string, expected bool) {
        let result = EmittedOracle.Evaluate((`package P3310ArrNil

var a = [2]int32{7, 8}
` + "$probe"))
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func OpenGenericSliceField_NilComparison_Binds() {
        // The null-ClrType shape: a `[]K` field of a generic class. The
        // comparison must bind symbolically, exactly like the #3303 map arm.
        let result = EmittedOracle.Evaluate(`package P3310OpenSliceNil

class G[K any] {
    var xs []K
    init() { xs = []K{} }
    func Ready() bool { return xs != nil }
}

func run() bool {
    var g = G[string]()
    return g.Ready()
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func BareSliceNilAssignment_StillRejected() {
        // Comparison-only (ADR-0104 discipline unchanged): nil cannot be
        // ASSIGNED into a bare slice slot.
        let result = EmittedOracle.Evaluate(`package P3310NoSliceNilAssign

var s = []int32{1}
s = nil
s == nil`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func BareChannelNilAssignment_StillRejected() {
        let result = EmittedOracle.Evaluate(`package P3310NoChanNilAssign


var c = chan[int32](1)
c = nil
c == nil`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }
}

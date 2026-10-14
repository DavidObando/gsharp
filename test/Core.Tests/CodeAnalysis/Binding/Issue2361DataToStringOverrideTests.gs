// <copyright file="Issue2361DataToStringOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit

/// Issue #2361 / ADR-0029 follow-up: a data class/struct's hand-written
/// `ToString` is the one synthesized member (of the six ADR-0029 names)
/// that may be declared explicitly, PROVIDED its shape exactly matches
/// `public ToString() string` (no parameters, not static, not generic,
/// not async, not unsafe, returning `string`). A compatible declaration
/// suppresses/replaces the synthesized ToString instead of being rejected
/// with GS0232; an incompatible one is rejected with the more specific
/// GS0487. The other five synthesized names (Equals/GetHashCode/
/// op_Equality/op_Inequality/Deconstruct) remain unconditionally forbidden —
/// see (cref:DataStructTests) for that pre-existing coverage, which
/// this file does not duplicate.
open class Issue2361DataToStringOverrideTests {
    @Fact
    func DataClass_CompatibleToStringOverride_InBody_NoDiagnostics() {
        let source = `
open data class Point(X int32, Y int32) {
    func ToString() string {
        return "custom"
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataClass_CompatibleToStringOverride_ExpressionBody_NoDiagnostics() {
        let source = `
open data class Point(X int32, Y int32) {
    func ToString() string -> "custom"
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataStruct_CompatibleToStringOverride_InBody_NoDiagnostics() {
        let source = `
data struct Point {
    var X int32
    var Y int32

    func ToString() string {
        return "custom"
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataClass_CompatibleToStringOverride_ReceiverClause_NoBlockingDiagnostics() {
        // ADR-0182: a receiver clause on an owned type is unconditionally an
        // extension now, so it never reaches the synthesized-member
        // collision check at all (that check only fires for the in-body
        // form) — this is simply an ordinary extension method named
        // ToString, distinct from the synthesized instance member.
        let source = `
open data class Point(X int32, Y int32) {
}

func (p Point) ToString() string {
    return "custom"
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232" || d.Id == "GS0487")
    }

    @Fact
    func DataStruct_CompatibleToStringOverride_ReceiverClause_NoBlockingDiagnostics() {
        let source = `
data struct Point {
    var X int32
    var Y int32
}

func (p Point) ToString() string {
    return "custom"
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232" || d.Id == "GS0487")
    }

    @Fact
    func DataStruct_ToStringWithParameter_InBody_ReportsGS0487() {
        // ADR-0182: a receiver clause is unconditionally an extension now,
        // so an incompatible-shape ToString written that way is just an
        // ordinary (unrelated) extension method, not a conflict — the
        // in-body form is the only spelling that can collide with the
        // synthesized ToString.
        let source = `
data struct Point {
    var X int32
    var Y int32

    func ToString(format string) string {
        return format
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0487")
    }

    @Fact
    func DataStruct_ToStringWithParameter_ReceiverClause_IsOrdinaryExtension_NoDiagnostics() {
        // ADR-0182: the receiver-clause spelling of this same shape no
        // longer collides with the synthesized ToString at all — it is an
        // ordinary extension method named ToString, distinct from the
        // synthesized instance member of the same name.
        let source = `
data struct Point {
    var X int32
    var Y int32
}

func (p Point) ToString(format string) string {
    return format
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0487")
    }

    @Fact
    func DataClass_SealedNonOpen_CompatibleToStringOverride_NoDiagnostics() {
        // Not `open` — the sealed/final-slot policy must still let a
        // compatible ToString through.
        let source = `
data class Point(X int32, Y int32) {
    func ToString() string -> "custom"
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataClass_DerivedOverridesToStringAgain_NoDiagnostics() {
        let source = `
open data class Base2361(Name string) {
    func ToString() string -> "base:" + Name
}
open data class Derived2361(Name string, Extra string) : Base2361(Name) {
    func ToString() string -> base.ToString() + ":" + Extra
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataClass_ToStringWithParameter_ReportsGS0487() {
        let source = `
open data class Point(X int32, Y int32) {
    func ToString(format string) string {
        return format
    }
}
0
`
        let result = Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0487")
        Assert.Contains("Point", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func DataClass_ToStringWrongReturnType_ReportsGS0487() {
        let source = `
open data class Point(X int32, Y int32) {
    func ToString() int32 {
        return 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0487")
    }

    @Fact
    func DataClass_AsyncToString_ReportsGS0487() {
        let source = `
open data class Point(X int32, Y int32) {
    async func ToString() string {
        return "x"
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0487")
    }

    @Fact
    func DataClass_GenericToString_ReportsGS0487() {
        let source = `
open data class Point(X int32, Y int32) {
    func ToString[T]() string {
        return "x"
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0487")
    }

    @Fact
    func DataClass_PrivateToString_ReportsGS0487() {
        let source = `
open data class Point(X int32, Y int32) {
    private func ToString() string {
        return "x"
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0487")
    }

    @Fact
    func DataClass_ExplicitToString_SharedBlock_StillReportsGS0232() {
        // A shared/static-block method named ToString can never be an
        // Object.ToString override — the ToString exception only applies to
        // instance methods. Statics stay unconditionally forbidden for ALL
        // six synthesized names.
        let source = `
open data class Point(X int32, Y int32) {
    shared {
        func ToString() string {
            return "x"
        }
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
    }

    @Fact
    func DataClass_ExplicitEqualsObject_StillReportsGS0232_RegressionControl() {
        // Regression control: the ToString exception must not widen to the
        // other five synthesized names.
        let source = `
open data class Point(X int32, Y int32) {
    func Equals(other any) bool {
        return false
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
    }

    @Fact
    func DataStruct_ExplicitOpEquality_StillReportsGS0232_RegressionControl() {
        let source = `
data struct Point {
    var X int32
    var Y int32
}

func (a Point) operator ==(b Point) bool {
    return true
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

// <copyright file="Issue3315NullableChannelSpellingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #3315, restated under ADR-0174 D2: the nullable-channel spelling.
/// With the element type inside brackets the two readings need no carve-out
/// — `chan[int32]?` is a nullable channel of `int32` (the GS0520
/// escape hatch for genuinely optional channel slots) and `chan[int32?]`
/// is a channel of nullable elements. Both are pinned here, alongside the
/// grouping forms `(T)?` that remain legal for every other composite.
open class Issue3315NullableChannelSpellingEmitTests {
    @Fact
    func ParenthesizedNullableChannel_Local_DefaultsToNil_NoGS0520() {
        // The optional-channel escape hatch: a `chan[T]?` slot is exempt
        // from GS0520 and zero-values to nil.
        let result = EmittedOracle.Evaluate(`package P3315NullChanZero


var c chan[int32]?
c == nil`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0520")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ParenthesizedNullableChannel_NilInitializer_Binds() {
        // Red→green witness: before #3315 `chan[int32]?` was a 1-tuple
        // parse and reported "unexpected token" in the binder.
        let result = EmittedOracle.Evaluate(`package P3315NullChanNilInit


var c chan[int32]? = nil
c == nil`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ParenthesizedNullableChannel_MakeAssignsIn_AndNilReassigns() {
        // A real channel flows into the nullable slot (T → T? lift), and nil
        // assignment is legal on the `?` spelling.
        let result = EmittedOracle.Evaluate(`package P3315NullChanMake


var c chan[int32]? = chan[int32](1)
var wasReady = c != nil
c = nil
wasReady && c == nil`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ParenthesizedNullableChannel_Field_NoGS0520() {
        // The originating scenario: a genuinely optional channel FIELD.
        let result = EmittedOracle.Evaluate(`package P3315NullChanField


class Worker {
    var inbox chan[int32]?
    func HasInbox() bool { return inbox != nil }
}

var w = Worker()
w.HasInbox()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0520")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(false, result.Value)
    }

    @Fact
    func UnparenthesizedQuestion_BindsToElement_NotChannel() {
        // The OTHER reading, spelled explicitly: `chan[int32?]` stays a
        // channel of nullable elements, so it is NOT nil-assignable.
        let result = EmittedOracle.Evaluate(`package P3315ElemBinding


var c chan[int32?] = nil`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ParenthesizedElement_SameTypeAsUnparenthesized() {
        // `chan (int32?)` and `chan[int32?]` denote the same type: a channel
        // of nullable int32 is accepted where the other spelling is declared.
        let result = EmittedOracle.Evaluate(`package P3315ElemEquiv


func take(c chan[int32?]) int32 { return 7 }

take(chan[int32?](1))`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func GroupedIdentifier_IsPlainNullable() {
        // Grouping is transparent: `(int32)?` ≡ `int32?`.
        let result = EmittedOracle.Evaluate(`package P3315GroupIdent

var x (int32)? = nil
var y int32? = x
y == nil`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func GroupedSlice_EqualsNullableArrayReferenceSpelling() {
        // `([]int32)?` ≡ `[]?int32` (the #1212 whole-array-nullable form).
        let result = EmittedOracle.Evaluate(`package P3315GroupSlice

var s ([]int32)? = nil
var t []?int32 = s
t == nil`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func GroupedMap_EqualsCanonicalNullableMapSpelling() {
        // `(map[string, int32])?` ≡ `map[string, int32]?` (ADR-0104).
        let result = EmittedOracle.Evaluate(`package P3315GroupMap

var m (map[string, int32])? = nil
var n map[string, int32]? = m
n == nil`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func BareChannel_StillReportsGS0520() {
        // The carve-out itself is unchanged: a bare `chan[T]` slot without an
        // initializer stays an error.
        let result = EmittedOracle.Evaluate(`package P3315BareChanStillGS0520


var c chan[int32]`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0520")
    }

    @Fact
    func TupleTypeClause_Unaffected() {
        // Real tuples (two or more elements) keep their meaning, including
        // the trailing `?` on the whole tuple.
        let result = EmittedOracle.Evaluate(`package P3315TupleUnaffected

var p (int32, string)? = nil
p == nil`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(true, result.Value)
    }
}

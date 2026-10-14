// <copyright file="NullableFlowAnalysisTests.cs" company="GSharp">
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

/// Phase 6.6 — nullable flow-analysis hardening for pattern arms and imported
/// CLR `[NotNullWhen]` contracts.
open class NullableFlowAnalysisTests {
    @Fact
    func SwitchStatement_TypePattern_NarrowsDiscriminantInArmBody() {
        let result = Evaluate(`
let s string? = "hello"
switch s {
case x is string { var len = s.Length }
default { }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func SwitchStatement_NonNilConstantPattern_NarrowsNullableValueInArmBody() {
        let result = Evaluate(`
let n int32? = 42
var y int32 = 0
switch n {
case 42 { y = n }
default { }
}
y
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func If_NegatedIsNullOrEmpty_NarrowsThenArm() {
        let result = Evaluate(`
let s string? = "world"
if !String.IsNullOrEmpty(s) {
    var len = s.Length
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsNullOrWhiteSpace_NarrowsElseArm() {
        let result = Evaluate(`
let s string? = "world"
if String.IsNullOrWhiteSpace(s) {
} else {
    var len = s.Length
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func SwitchStatement_DiscardAndDefaultArms_DoNotNarrow() {
        let discard = Evaluate(`
let s string? = "world"
switch s {
case _ { var len = s.Length }
}
`)
        let defaultArm = Evaluate(`
let s string? = "world"
switch s {
default { var len = s.Length }
}
`)
        Assert.Contains(
            discard.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
        Assert.Contains(
            defaultArm.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func SwitchExpression_TypePattern_NarrowsDiscriminantInArmResult() {
        let result = Evaluate(`
let s string? = "hello"
let len = switch s { case x is string: s.Length default: 0 }
len
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func If_UserDefinedNotNullWhenTrue_NarrowsThenArm() {
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

func TryFetch(@NotNullWhen(true) s string?) bool {
    return s != nil
}

let v string? = "hello"
if TryFetch(v) {
    var len = v.Length
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_NegatedUserDefinedNotNullWhenTrue_NarrowsElseArm() {
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

func TryFetch(@NotNullWhen(true) s string?) bool {
    return s != nil
}

let v string? = "hello"
if !TryFetch(v) {
} else {
    var len = v.Length
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_UserDefinedNotNullWhenFalse_NarrowsElseArm() {
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

func IsMissing(@NotNullWhen(false) s string?) bool {
    return s == nil
}

let v string? = "hello"
if IsMissing(v) {
} else {
    var len = v.Length
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_UserDefinedMaybeNullWhen_DoesNotNarrow() {
        // [MaybeNullWhen(false)] on a nullable string? arg cannot prove non-nullness
        // in the then-arm, so accessing .Length must still error there.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

func Probe(@MaybeNullWhen(false) s string?) bool {
    return s != nil
}

let v string? = "hello"
if Probe(v) {
    var len = v.Length
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func If_UserDefinedMaybeNullWhenFalse_OnNonNullArg_WidensElseArm() {
        // [MaybeNullWhen(false)] on a non-nullable string arg must widen the
        // caller's variable to string? in the else arm (where the call returned false).
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

func TryGet(@MaybeNullWhen(false) s string) bool {
    return s.Length > 0
}

let v = "hello"
if TryGet(v) {
} else {
    var len = v.Length
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func If_UserDefinedMaybeNullWhenFalse_OnNonNullArg_DoesNotWidenThenArm() {
        // [MaybeNullWhen(false)] fires on false, so the then-arm (true return)
        // must leave the variable as non-nullable — .Length access must succeed.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

func TryGet(@MaybeNullWhen(false) s string) bool {
    return s.Length > 0
}

let v = "hello"
if TryGet(v) {
    var len = v.Length
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_UserDefinedMaybeNullWhenTrue_OnNonNullArg_WidensThenArm() {
        // [MaybeNullWhen(true)] fires on true, so the then-arm must see the
        // variable widened to string? — .Length access must fail.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

func IsEmpty(@MaybeNullWhen(true) s string) bool {
    return false
}

let v = "hello"
if IsEmpty(v) {
    var len = v.Length
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func If_NegatedUserDefinedMaybeNullWhenFalse_OnNonNullArg_WidensThenArm() {
        // Negating the call flips the arm: !TryGet(v) is true exactly when
        // TryGet returned false, so the then-arm now sees the [MaybeNullWhen(false)]
        // widening and .Length must fail.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

func TryGet(@MaybeNullWhen(false) s string) bool {
    return s.Length > 0
}

let v = "hello"
if !TryGet(v) {
    var len = v.Length
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    // Issue #229 — BoundImportedInstanceCallExpression narrowing
    @Fact
    func If_DictionaryTryGetValue_SuccessArm_OutParamConfirmedNonNullable() {
        // dict.TryGetValue carries [NotNullWhen(true)] on the out parameter.
        // In the then-arm (true return), `value` must be narrowed to non-nullable
        // and .Length access must succeed.
        let result = Evaluate(`
import System.Collections.Generic

var dict = Dictionary[string, string]()
dict["key"] = "hello"
var value = ""
if dict.TryGetValue("key", &value) {
    var len = value.Length
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_DictionaryTryGetValue_FailureArm_OutParamWidenedToNullable() {
        // dict.TryGetValue carries [MaybeNullWhen(false)] on the out parameter.
        // In the else-arm (false return), `value` must be widened to string?
        // and .Length access must be rejected.
        let result = Evaluate(`
import System.Collections.Generic

var dict = Dictionary[string, string]()
var value = ""
if dict.TryGetValue("key", &value) {
} else {
    var len = value.Length
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func If_NegatedDictionaryTryGetValue_SuccessArm_OutParamNotWidened() {
        // !dict.TryGetValue(...) is true when the call returned false, so the
        // then-arm is the failure arm: value must be widened to string? and
        // .Length access must be rejected.
        let result = Evaluate(`
import System.Collections.Generic

var dict = Dictionary[string, string]()
var value = ""
if !dict.TryGetValue("key", &value) {
    var len = value.Length
}
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func If_NegatedDictionaryTryGetValue_ElseArm_OutParamIsNonNullable() {
        // !dict.TryGetValue(...) else-arm is the success arm: value must be
        // narrowed to non-nullable and .Length access must succeed.
        let result = Evaluate(`
import System.Collections.Generic

var dict = Dictionary[string, string]()
dict["key"] = "hello"
var value = ""
if !dict.TryGetValue("key", &value) {
} else {
    var len = value.Length
}
`)
        Assert.Empty(result.Diagnostics)
    }

    // Issue #208 — [MemberNotNull] / [MemberNotNullWhen] field postconditions
    @Fact
    func MemberNotNull_AfterHelperCall_FieldNarrowedToNonNullable() {
        // EnsureInit() carries [MemberNotNull("_name")]. After the call, bare
        // name access _name.Length must succeed without a nil-guard.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

class Box {
    var _name string?

    func EnsureInit() {
        _name = "default"
    }

    @MemberNotNull(members: []string{"_name"})
    func EnsureInitAnnotated() {
        _name = "default"
    }

    func Run() int32 {
        this.EnsureInitAnnotated()
        return _name.Length
    }
}

var b = Box{}
b.Run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func MemberNotNull_WithoutHelperCall_FieldRemainsNullable() {
        // Without calling the [MemberNotNull] helper, _name stays nullable and
        // .Length access must be rejected.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

class Box {
    var _name string?

    @MemberNotNull("_name")
    func EnsureInit() {
        _name = "hello"
    }

    func Run() int32 {
        return _name.Length
    }
}

var b = Box{}
b.Run()
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func MemberNotNull_AfterHelperCall_FieldInvalidatedBySubsequentAssignment() {
        // After the [MemberNotNull] helper call, assigning nil to _name must
        // invalidate the narrowing so a subsequent .Length access is rejected.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

class Box {
    var _name string?

    @MemberNotNull("_name")
    func EnsureInit() {
        _name = "hello"
    }

    func Run() int32 {
        this.EnsureInit()
        _name = nil
        return _name.Length
    }
}

var b = Box{}
b.Run()
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func MemberNotNullWhen_ThenArm_FieldNarrowedOnMatchingReturn() {
        // TryGet() returns true when _name is non-null per [MemberNotNullWhen(true,"_name")].
        // The then-arm must see _name narrowed and .Length must succeed.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

class Box {
    var _name string?

    @MemberNotNullWhen(true, "_name")
    func TryGet() bool {
        return _name != nil
    }

    func Run() int32 {
        if this.TryGet() {
            return _name.Length
        }
        return 0
    }
}

var b = Box{}
b._name = "hello"
b.Run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func MemberNotNullWhen_ElseArm_FieldRemainsNullableOnNonMatchingReturn() {
        // In the else-arm TryGet() returned false, so _name is still nullable
        // and .Length must be rejected.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

class Box {
    var _name string?

    @MemberNotNullWhen(true, "_name")
    func TryGet() bool {
        return _name != nil
    }

    func Run() int32 {
        if this.TryGet() {
        } else {
            return _name.Length
        }
        return 0
    }
}

var b = Box{}
b.Run()
`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot find member Length.", StringComparison.Ordinal)
        )
    }

    @Fact
    func MemberNotNullWhen_NegatedCall_ElseArmNarrowed() {
        // !TryGet() is true when TryGet() returned false — so the then-arm is
        // the failure arm. The else-arm sees the true-return and _name is narrowed.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

class Box {
    var _name string?

    @MemberNotNullWhen(true, "_name")
    func TryGet() bool {
        return _name != nil
    }

    func Run() int32 {
        if !this.TryGet() {
        } else {
            return _name.Length
        }
        return 0
    }
}

var b = Box{}
b._name = "world"
b.Run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func MemberNotNull_MultipleFields_BothNarrowed() {
        // [MemberNotNull("_a", "_b")] should narrow both fields after the call.
        let result = Evaluate(`
import System.Diagnostics.CodeAnalysis

class Pair {
    var _a string?
    var _b string?

    @MemberNotNull("_a", "_b")
    func Init() {
        _a = "hello"
        _b = "world"
    }

    func Run() int32 {
        this.Init()
        return _a.Length + _b.Length
    }
}

var p = Pair{}
p.Run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

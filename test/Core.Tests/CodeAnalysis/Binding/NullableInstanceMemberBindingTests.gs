// <copyright file="NullableInstanceMemberBindingTests.cs" company="GSharp">
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

/// Issue #517 — exposes `System.Nullable<T>`'s instance API
/// (`Value`, `HasValue`, `GetValueOrDefault`) on a
/// value-type `T?` receiver through the binder, the same way any other
/// CLR struct's instance members are reachable. Verifies the binder no
/// longer reports `GS0158` for these reads/calls and that NRT
/// (reference-type nullable) receivers continue to surface `GS0158`
/// because they have no `Nullable<T>` projection.
open class NullableInstanceMemberBindingTests {
    @Fact
    func NullableInt32_Value_Binds() {
        let source = `
var a int32? = 7
var v = a.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableInt32_HasValue_Binds() {
        let source = `
var a int32? = 7
var h = a.HasValue
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableBool_Value_Binds() {
        let source = `
var a bool? = true
var v = a.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableBool_HasValue_Binds() {
        let source = `
var a bool? = nil
var h = a.HasValue
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Nullable_GetValueOrDefault_NoArg_Binds() {
        let source = `
var a int32? = nil
var d = a.GetValueOrDefault()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Nullable_GetValueOrDefault_WithFallback_Binds() {
        let source = `
var a int32? = nil
var d = a.GetValueOrDefault(42)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableDateTime_Value_Binds() {
        let source = `
import System

var a DateTime? = DateTime.UtcNow
var v = a.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableDateTime_HasValue_Binds() {
        let source = `
import System

var a DateTime? = nil
var h = a.HasValue
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableInt32_OnParameter_Binds() {
        let source = `
func describe(x int32?) bool {
    return x.HasValue
}

var r = describe(5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableInt32_OnField_Binds() {
        let source = `
class Holder {
    var Flag bool?

    init() {
        Flag = nil
    }
}

var h = Holder()
var v = h.Flag.HasValue
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Nullable_StringNrt_HasValue_StillDiagnoses() {
        // Per issue #517: NRT reference nullables (`string?`) do NOT
        // project to `System.Nullable<T>` — the binder must keep returning
        // GS0158 for `.HasValue` on a reference-type nullable so users
        // pick the right pattern (`s == nil` / `?.`) rather than a
        // value-type-only API that does not exist on the underlying type.
        let source = `
var s string? = nil
var h = s.HasValue
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot find member HasValue"))
    }

    @Fact
    func Nullable_StringNrt_Value_StillDiagnoses() {
        let source = `
var s string? = nil
var v = s.Value
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot find member Value"))
    }

    @Fact
    func Nullable_UnknownMember_StillDiagnoses() {
        // `Nullable<T>` doesn't define `Magic`; the binder must still report
        // GS0158 so we don't silently bind to nothing.
        let source = `
var a int32? = 1
var m = a.Magic
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot find member Magic"))
    }

    @Fact
    func NullableValue_AccessOnNil_ThrowsInvalidOperation() {
        // End-to-end through the emitted oracle: `.Value` on a nil-valued
        // nullable must surface the BCL's `InvalidOperationException`
        // (#504 / #517). The oracle wraps unhandled runtime exceptions in a
        // GS9999 diagnostic carrying the original message text.
        let source = `
var a int32? = nil
var v = a.Value
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9999" && d.Message.Contains("Nullable"))
    }

    @Fact
    func NullableHasValue_OnNil_ReturnsFalse() {
        let source = `
var a int32? = nil
a.HasValue
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value)
    }

    @Fact
    func NullableGetValueOrDefault_NoArg_OnNil_ReturnsZero() {
        let source = `
var a int32? = nil
a.GetValueOrDefault()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func NullableGetValueOrDefault_WithFallback_OnNil_ReturnsFallback() {
        let source = `
var a int32? = nil
a.GetValueOrDefault(99)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func NullableGetValueOrDefault_WithFallback_OnHasValue_ReturnsActual() {
        let source = `
var a int32? = 7
a.GetValueOrDefault(99)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

// <copyright file="Issue3747NullableParamsElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #3747 — `nil` in an expanded `params` position.
///
/// `OverloadResolver.ExpandParamsArguments` derived the params ELEMENT
/// type with a bare `TypeSymbol.FromClrType(paramArrayType.GetElementType())`,
/// which sees only the erased CLR shape. The declaration's `[Nullable]`
/// metadata was therefore dropped and every `params T?[]` element bound as
/// non-null `T`, so `nil` in an expanded position failed
/// `GS0155 Cannot convert type 'nil' to 'object'` — note the target prints
/// as `object`, not `object?`, which is the annotation loss showing
/// through the diagnostic.
///
/// The issue as filed believed the defect was specific to a NULLABLE params
/// ARRAY (`params object?[]?`, as on `Delegate.DynamicInvoke`), citing
/// `string.Format("{0} {1}", "x", nil)` as a working control over a
/// non-nullable `params object?[]`. That control was not a control: two
/// trailing arguments bind the NON-params overload
/// `Format(string, object?, object?)` and never expand at all.
/// (cref:PlainNullableElement_ArrayNotNullable_AlsoBinds) forces genuine
/// expansion with five arguments and fails on `main` identically, so the
/// defect was never about the array's own nullability. Both spellings are kept
/// here because they are the two halves of that correction.
///
/// This is the #3705-family "inconsistent sibling probe" shape but a distinct
/// site from PR #3741's — that PR fixed the signature-position readers in
/// `MemberLookup`; this is the params-expansion element reader. It is NOT
/// a regression of #3741.
open class Issue3747NullableParamsElementTests {
    /// The issue's own repro: `Delegate.DynamicInvoke(params object?[]? args)`.
    /// Executed, not merely bound — the packed array must still emit as
    /// `object[]` with a null slot, and the invoked delegate returns it.
    @Fact
    func NullableParamsArray_AcceptsNilElement_AndRoundTrips() {
        let result = EmittedOracle.Evaluate(`
import System

let d Func[object?, object?, object?] = func (a object?, b object?) object? {
    return b
}
let del Delegate = d
del.DynamicInvoke("x", nil)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.Value)
    }

    /// The array itself is NOT nullable here (`string.Format(string, params object?[])`),
    /// and five arguments force real expansion past every fixed overload. This
    /// is the assertion that disproves the issue's stated isolation.
    @Fact
    func PlainNullableElement_ArrayNotNullable_AlsoBinds() {
        let result = EmittedOracle.Evaluate(`
import System

string.Format("{0}|{1}|{2}|{3}|{4}", "a", "b", "c", "d", nil)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("a|b|c|d|", result.Value)
    }

    /// The negative control, and the reason the fix reads the declaration rather
    /// than blanket-nullifying every params element: a `params string[]`
    /// whose element is annotated NON-null must still reject `nil`. A fix
    /// that simply widened the element type would turn this green and lose the
    /// soundness the annotation buys.
    @Fact
    func NonNullParamsElement_StillRejectsNil() {
        let result = EmittedOracle.Evaluate(`
import System.IO

Path.Combine("a", "b", "c", nil)
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    /// Anti-vacuity: an ordinary non-nil element still flows through the
    /// expanded position unchanged, so the fix cannot be passing above merely by
    /// erasing the element type to something that accepts anything.
    @Fact
    func NonNilElements_StillPackAndFormat() {
        let result = EmittedOracle.Evaluate(`
import System

string.Format("{0}|{1}|{2}|{3}|{4}", 1, 2, 3, 4, 5)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("1|2|3|4|5", result.Value)
    }
}

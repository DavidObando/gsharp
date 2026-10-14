// <copyright file="Issue1701NullabilityConversionCracksTests.cs" company="GSharp">
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

/// Issue #1701: two residual cracks in the Kotlin-model null-safety
/// invariant ("a reference `T?` must never implicitly convert to
/// non-nullable `T`"), surfaced during the #1627 review.
///
/// Crack 2 — `Conversion.Classify`'s nullable-open-type-parameter arm
/// (issue #1455) must block the implicit box ONLY when `T` is provably
/// reference-type-constrained (`HasReferenceTypeConstraint`, e.g.
/// `[T class]`) — that is the sole shape where `T?` is a genuine
/// nullable REFERENCE per the Kotlin-model null-safety invariant, so the
/// implicit box would erase a possibly-null value into a non-null slot.
/// Every other shape — `struct`-constrained (genuine
/// `Nullable<T>`), interface-constrained, class-base-constrained,
/// and unconstrained — boxes via the CLR's ordinary generic `box !!T`
/// rule and must remain implicit (issue #1455); an earlier revision of this
/// fix over-broadly gated on `HasValueTypeConstraint` and regressed
/// #1455 for all non-struct-constrained shapes. These tests assert the
/// class-constrained erasure reports a null-safety diagnostic while every
/// legitimate sibling conversion keeps compiling.
open class Issue1701NullabilityConversionCracksTests {
    @Fact
    func ClassConstrainedNullableTypeParam_ToObject_ReportsNullSafetyDiagnostic() {
        // A ref-like T? boxed to non-nullable `object` must NOT be implicit;
        // this is the #1701 crack-2 erasure.
        let source = `
package p
func Issue1701ASink[T class](x T?) object -> x
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155" || d.Message.Contains("Cannot convert")
        )
    }

    @Fact
    func UnconstrainedNullableTypeParam_ToObject_StillCompiles() {
        // #1455 guard: an unconstrained T's `!!T` box works for both struct
        // and reference instantiations, so this must NOT be blocked.
        let source = `
package p
func Issue1701BSink[T](x T?) object -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func InterfaceConstrainedNullableTypeParam_ToInterface_StillCompiles() {
        // #1455 guard: interface-only constraint is not provably
        // reference-nullable (a struct can implement the interface), so this
        // must NOT be blocked.
        let source = `
package p
import System
func Issue1701GSink[T IComparable](x T?) IComparable -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ConcreteNullableReference_ToNullableObject_StillCompiles() {
        // A concrete nullable reference (not a generic type parameter) to a
        // NULLABLE object target must remain implicit — only the
        // non-nullable object erasure is the #1701 crack.
        let source = `
package p
class Issue1701CBox {}
func Issue1701CSink(x Issue1701CBox?) object? -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ClassConstrainedNullableTypeParam_BangEscape_ToObject_StillCompiles() {
        let source = `
package p
func Issue1701DSink[T class](x T?) object -> x!!
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ClassConstrainedNonNullableTypeParam_ToObject_StillCompiles() {
        // Bare non-nullable T -> object (issue #1540) must be unaffected.
        let source = `
package p
func Issue1701ESink[T class](x T) object -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func StructConstrainedNullableTypeParam_ToObject_StillCompiles() {
        // Value-type Nullable<T> boxing to object is a different, legitimate
        // path and must remain implicit.
        let source = `
package p
func Issue1701FSink[T struct](x T?) object -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
        }
    }
}

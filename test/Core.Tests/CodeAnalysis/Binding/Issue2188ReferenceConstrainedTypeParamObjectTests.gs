// <copyright file="Issue2188ReferenceConstrainedTypeParamObjectTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #2188: a reference-constrained type parameter (`[T class …]` or a
/// class-base constraint such as `[T Base]`) is provably a reference type,
/// so it must participate in reference conversions and reference equality in
/// both its nullable (`T?`) and non-nullable (`T`) forms, exactly like
/// any other reference type:
/// - `T -> object` and `T? -> object?` are implicit (GS0155 previously rejected the nullable form).
/// - `object?/object == T?/T` and `!=` resolve to reference equality in either operand order (GS0129
/// previously rejected them).
/// The fix generalises rather than special-casing `object`: the same rule
/// covers base-class and interface targets in the constraint set. Unconstrained
/// and `struct`-constrained parameters (whose `T?` erases to
/// `Nullable<T>`, a value type) are intentionally excluded and keep
/// their value-type rules — the negative cases below prove they still error.
open class Issue2188ReferenceConstrainedTypeParamObjectTests {
    @Fact
    func ClassConstrainedNullableTypeParam_ToNullableObject_Assignment_Compiles() {
        let source = `
package p
func Sink[T class init()]() {
    var v T? = nil
    var box object? = v
    box = v
}
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ClassConstrainedNullableTypeParam_ToNullableObject_Return_Compiles() {
        let source = `
package p
func Sink[T class](x T?) object? -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func ClassConstrainedNonNullableTypeParam_ToObject_StillCompiles() {
        // Guard: the pre-existing `T -> object` reference conversion (#1540)
        // must keep working alongside the new nullable form.
        let source = `
package p
func Sink[T class](x T) object -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableObject_EqualsNullableClassTypeParam_Compiles() {
        let source = `
package p
func Cmp[T class](x T?, o object?) bool -> o == x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableClassTypeParam_NotEqualsNullableObject_Compiles() {
        // Reverse operand order must resolve identically.
        let source = `
package p
func Cmp[T class](x T?, o object?) bool -> x != o
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NonNullableObject_EqualsNonNullableClassTypeParam_Compiles() {
        let source = `
package p
func Cmp[T class](x T, o object) bool -> o == x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func BaseClassConstrainedNullableTypeParam_ToNullableObject_Compiles() {
        // Generalisation: a class-base constraint (`[T Animal]`) is also a
        // provable reference type.
        let source = `
package p
class Animal { init() {} }
func Sink[T Animal](x T?) object? -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func BaseClassConstrainedNullableTypeParam_ToNullableBase_Compiles() {
        // Not special-cased to `object`: the reference conversion also reaches
        // the base-class constraint target.
        // ADR-0156 Phase 3c (#3176): unpinned onto the emitted oracle — the
        // #3241 emitter fix lowers the constrained nullable type parameter
        // to its nullable base (issue #3236).
        let source = `
package p
class Animal { init() {} }
func Sink[T Animal](x T?) Animal? -> x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func BaseClassConstrained_NullableBaseEqualsNullableTypeParam_Compiles() {
        let source = `
package p
class Animal { init() {} }
func Cmp[T Animal](x T?, a Animal?) bool -> a == x
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func UnconstrainedNullableTypeParam_ToNullableObject_ReportsConversionError() {
        // Negative: an UNCONSTRAINED T's `T?` is `Nullable<T>` (a value type),
        // NOT a reference — it must NOT convert to `object?`.
        let source = `
package p
func Sink[T](x T?) object? -> x
`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0155" || d.Message.Contains("Cannot convert"))
    }

    @Fact
    func UnconstrainedNullableTypeParam_EqualsNullableObject_ReportsOperatorError() {
        // Negative: reference equality must NOT be admitted for an
        // unconstrained (value-or-reference) `T?`.
        let source = `
package p
func Cmp[T](x T?, o object?) bool -> o == x
`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func StructConstrainedNullableTypeParam_EqualsNullableObject_ReportsOperatorError() {
        // Negative: a `struct`-constrained `T?` is a genuine `Nullable<T>`
        // value type and must not be reference-compared to `object?`.
        let source = `
package p
func Cmp[T struct](x T?, o object?) bool -> o == x
`
        let diagnostics = Evaluate(source).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func ExactIssueRepro_Compiles() {
        let source = `
package Repro
class C {
    shared {
        var box object?
        func Put[T class init()]() {
            var v T? = nil
            C.box = v
            if C.box != v {
                C.box = nil
            }
        }
    }
}
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
        }
    }
}

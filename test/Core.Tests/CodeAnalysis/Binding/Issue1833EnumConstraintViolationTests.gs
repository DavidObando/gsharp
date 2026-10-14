// <copyright file="Issue1833EnumConstraintViolationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #1833 (follow-up review note on PR #1832 / #1601): a type argument
/// that is `struct`-constrained but <b>not</b> `Enum`-constrained — a
/// concrete non-enum user struct, or a bare `[T struct]` type parameter —
/// passed to a method whose type parameter carries a real `System.Enum`
/// base-class constraint (e.g. `Enum.IsDefined<TEnum>` — <b>not</b>
/// `Enum.TryParse`, whose real BCL signature only constrains
/// `TEnum : struct` with no `Enum` base bound at all) must be
/// rejected at bind time with a clear `GS0152` constraint-violation
/// diagnostic instead of silently binding through overload resolution and
/// only failing later at CLR verification.
///
/// Root cause: `ClrOverloadResolution.SatisfiesGenericConstraints`'s
/// base-type-constraint loop treated <em>every</em> `System.ValueType`-
/// or `System.Enum`-named constraint as satisfied once the argument was
/// classified as a value-type-erased symbol (`IsValueTypeErasedSymbol`,
/// added by #1601). That is correct for `ValueType` (any struct/enum
/// satisfies it) but wrong for `Enum` — a plain struct, or a struct-only
/// type parameter, does not derive from `System.Enum`. The fix walks the
/// recovered symbol's real derivation/constraint chain
/// (`ValueTypeErasedSymbolSatisfiesBaseConstraint`) so only an actual enum
/// (or a type parameter that itself carries an `Enum` bound) satisfies the
/// `Enum` constraint, while `ValueType`/`Object` remain
/// trivially satisfied by any value type.
open class Issue1833EnumConstraintViolationTests {
    @Fact
    func ConcreteNonEnumStruct_EnumIsDefined_ReportsConstraintViolation_NotCrash() {
        // (a) A concrete user struct (not an enum) explicitly supplied as
        // Enum.IsDefined's type argument must be rejected at bind time with
        // the GS0152 constraint-violation diagnostic — not silently bound
        // (which would only fail later at CLR verification/emit).
        const source = `
package p
import System

struct Point {
    var X int32
    var Y int32
}

var pt = Point(1, 2)
var ok = Enum.IsDefined[Point](pt)
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func StructOnlyTypeParameter_ForwardedToEnumIsDefined_ReportsConstraintViolation() {
        // (b) A bare `[T struct]` type parameter (struct-constrained but NOT
        // Enum-constrained) forwarded to Enum.IsDefined[T] must also be
        // rejected at bind time with GS0152 — it is indistinguishable from an
        // arbitrary non-enum struct from Enum.IsDefined's point of view.
        const source = `
package p
import System

func Check[T struct](v T) bool {
    return Enum.IsDefined[T](v)
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func EnumConstrainedTypeParameter_EnumIsDefined_DoesNotFalsePositive() {
        // Negative control mirroring (a)/(b): an in-scope type parameter that
        // itself genuinely carries the `Enum` bound (`[TEnum Enum struct]`)
        // must NOT trip the new GS0152 constraint-violation diagnostic when
        // forwarded to Enum.IsDefined[TEnum] — `ValueTypeErasedSymbolSatisfies
        // BaseConstraint` must recognize its `ClassConstraint` as the real
        // `System.Enum` bound. (Whether the call resolves end-to-end is
        // unaffected by this fix either way — see the dedicated Enum.TryParse
        // regression test below for the full round-trip guard.)
        const source = `
package p
import System

func Check[TEnum Enum struct](v TEnum) bool {
    return Enum.IsDefined[TEnum](v)
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func ConcreteEnum_EnumTryParse_StillBinds_Issue1601Regression() {
        // (c) Regression guard for the exact #1601 repro shape:
        // Enum.TryParse[TEnum] with TEnum: Enum, struct forwarded, and the
        // concrete same-compilation enum control — Enum.TryParse's real BCL
        // constraint is only `struct` (no `Enum` base), so this must be
        // completely unaffected by the new base-constraint enforcement.
        const source = `
package p
import System

func Parse[TEnum Enum struct](arg string) TEnum? {
    if !Enum.TryParse[TEnum](arg, out var result) {
        return nil
    }
    return result
}

enum Color { Red, Green }

var ok = Enum.TryParse[Color]("Red", out var concrete)
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
        Assert.Empty(diagnostics)
    }

    @Fact
    func StructOnlyTypeParameter_MemoryMarshalCast_StillBinds_GeneralizationPositiveCase() {
        // (d) Generalization positive control: the SAME bare `[T struct]` type
        // parameter that must be REJECTED against Enum.IsDefined's `Enum` bound
        // (test (b) above) must still be ACCEPTED against a method whose only
        // base-type constraint is the implicit `ValueType` one (MemoryMarshal
        // .Cast's `where TFrom : struct, TTo : struct`) — proving the fix
        // enforces the ACTUAL constraint instead of blanket-rejecting every
        // value-type-erased argument.
        const source = `
package p
import System.Runtime.InteropServices

func Cast[T struct](s Span[T]) Span[uint8] {
    return MemoryMarshal.Cast[T, uint8](s)
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9999")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0152")
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics.ToList()
        }
    }
}

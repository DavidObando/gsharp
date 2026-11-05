// <copyright file="Issue2354ReturnNilAndSelfReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2345 follow-up (deferred finding #2). Issue #4316 reversed the `return nil` half:
/// `nil` converts only to a `?` slot, so the `return nil` tests below now expect GS0155.
/// The original report: a plain G# `class` could not
/// `return nil` for its own non-nullable type (`GS0155: Cannot convert type
/// 'nil' to '<Class>'`), and a method declared inside a GENERIC class
/// could not `return this` for its own generic self-type (`GS0155: Cannot
/// convert type '<Class>' to '<Class>'` — an identical-looking
/// source/target that hid a genuine type-identity mismatch).
///
/// Root causes and fixes:
/// * `return nil`: `Conversion.Classify`'s "Phase 3.C.2" rule rejected
/// `nil ->` any non-(cref:GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol)
/// target unconditionally — including reference-capable targets (a
/// `class`, an interface, a reference-constrained type parameter, or
/// `object`) that are ALWAYS nullable at the CLR level regardless of an
/// explicit `?` spelling. The rule is now scoped to genuine value types
/// via a new, deliberately NARROW predicate,
/// the nil rule of `Conversion.Classify` (the old predicate was removed by #4316) (a `class`, an
/// interface, or a reference-constrained type parameter — NOT the wider
/// `Conversion.IsReferenceLikeTarget`, which also matches general
/// CLR-backed reference types like `string`/`object`/function types that
/// deliberately keep requiring an explicit `T?` per issues #2159/#715),
/// so ONLY a real struct/value-kind target (or one of those excluded
/// CLR-backed types) still requires an explicit `T?` wrapper.
/// * `return this` (generic self-type): a generic class's own `this`
/// parameter is bound with the OPEN generic definition as its type
/// (`TypeArguments` empty), while a self-referential member-signature
/// type written explicitly in source (e.g. `func Self() Box[T]` inside
/// `class Box[T]`) binds through `StructSymbol.Construct`, producing a
/// DIFFERENT (but structurally identical) `StructSymbol` instance.
/// `Conversion.Classify` now recognizes this "self-instantiation" identity
/// (`AreSameConstructedStructIdentity`) — same `Definition`, and every
/// type-argument slot (defaulting an open definition's empty
/// `TypeArguments` to its own `TypeParameters`) pairwise identical —
/// and the emitter's `IsReferenceCompatible` mirrors the same check so
/// emission recognizes it as a no-op reference load.
open class Issue2354ReturnNilAndSelfReturnTests {
    @Fact
    func GenericClass_ReturnThis_OwnGenericSelfType_Binds() {
        const source = `package p
class Box[T] {
    func Self() Box[T] {
        return this
    }
}`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func NonGenericClass_ReturnThis_StillBinds() {
        // Control: the non-generic case was never broken; guard against a
        // regression while generalizing the generic case.
        const source = `package p
class Box {
    func Self() Box {
        return this
    }
}`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func GenericClass_ReturnNil_OwnGenericType_ReportsGS0155() {
        // Issue #4316: `nil` converts only to a `?` slot, so a bare generic
        // class return type refuses it like every other reference type.
        const source = `package p
class Box[T] {
    func Nothing() Box[T] {
        return nil
    }
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func NonGenericClass_ReturnNil_ReportsGS0155() {
        const source = `package p
class Box {
    func Nothing() Box {
        return nil
    }
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func Interface_ReturnNil_ReportsGS0155() {
        const source = `package p
interface Greeter {
    func Greet() string;
}
class Box {
    func AsGreeter() Greeter {
        return nil
    }
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func ObjectReturnType_ReturnNil_StillReportsGS0155() {
        // Control: `object` always required an explicit `object?`, like
        // `string` and function-typed slots (issues #2159 / #715).
        const source = `package p
class Box {
    func AsObject() object {
        return nil
    }
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func NestedNullableSelfType_ReturnThis_Binds() {
        // A generic self-return wrapped in a further `?` (Box[T]?) exercises
        // the reference-upcast-to-nullable path recursing into the same
        // self-instantiation identity check.
        const source = `package p
class Box[T] {
    func Wrapped() Box[T]? {
        return this
    }
}`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func PlainClass_EqualsNil_Binds() {
        // Generalizes issue #2300 (interface / type-parameter `== nil`) to a
        // plain non-nullable `class` operand — the same CLR reference-typed
        // rationale applies.
        const source = `package p
class Box {
}
func Guard(b Box) bool {
    return b == nil
}`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func PlainClass_NotEqualsNil_Binds() {
        const source = `package p
class Box {
}
func Guard(b Box) bool {
    return b != nil
}`
        Assert.Empty(GetErrors(source))
    }

    @Fact
    func GenericClass_ReturnThis_DifferentGenericClass_StillReportsGS0155() {
        // Negative control: a method declared inside `Bag[T]` that claims to
        // return `Box[T]` and does `return this` must still fail — the two
        // classes are genuinely different `Definition`s, so
        // AreSameConstructedStructIdentity must reject this pair.
        const source = `package p
class Box[T] {
}
class Bag[T] {
    func F() Box[T] {
        return this
    }
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func GenericClass_ReturnThis_DifferentClosedTypeArgument_StillReportsGS0155() {
        // Negative control: `this` inside `Box[T]` is the OPEN self-type; a
        // return type explicitly closed over a DIFFERENT type argument
        // (`Box[int32]`) must still fail, proving the fix does not
        // over-broadly accept any two constructed shapes of the same
        // definition.
        const source = `package p
class Box[T] {
    func F() Box[int32] {
        return this
    }
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func UnrelatedClasses_ReturnMismatch_StillReportsGS0155() {
        // Negative control: a genuinely incompatible return must still fail
        // — the reference-like `nil ->` and self-instantiation-identity
        // rules must not weaken ordinary type-mismatch diagnostics.
        const source = `package p
class A {
}
class B {
}
class C {
    func F() A {
        return B()
    }
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func Struct_ReturnNil_StillReportsGS0155() {
        // Negative control: a genuine value-type (struct) return type must
        // still require an explicit `T?` wrapper to accept `nil` — the
        // reference-like relaxation must not apply to structs.
        const source = `package p
struct Point {
    var X int32
}
class Box {
    func Get() Point {
        return nil
    }
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func Struct_EqualsNil_StillReportsGS0129() {
        // Negative control: a struct-typed (non-nullable value type) operand
        // must still reject `== nil` / `!= nil` — only reference-capable
        // types gained this allowance.
        const source = `package p
struct Point {
    var X int32
}
func Guard(p Point) bool {
    return p == nil
}`
        Assert.Contains(GetErrors(source), (d Diagnostic) -> d.Id == "GS0129")
    }

    shared {
        private func GetErrors(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree){IsLibrary = true}
            let parseDiagnostics = tree.Diagnostics
            let bindDiagnostics = compilation.GlobalScope.Diagnostics
            let programDiagnostics = compilation.BoundProgram.Diagnostics
            return parseDiagnostics
                .Concat(bindDiagnostics)
                .Concat(programDiagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }
    }
}

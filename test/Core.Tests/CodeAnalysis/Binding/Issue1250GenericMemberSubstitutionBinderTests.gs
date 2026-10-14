// <copyright file="Issue1250GenericMemberSubstitutionBinderTests.cs" company="GSharp">
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

/// Issue #1250: when a member is accessed through a constructed generic receiver,
/// a member-signature type that is itself a constructed generic type using the
/// class's type parameter (e.g. `Holder[T]` on `Box[T]`) must be
/// substituted with the receiver's type arguments (`Holder[int32]` on
/// `Box[int32]`). Before the fix only bare type parameters (`T`) and
/// arrays of type parameters (`[]T`) were substituted; constructed generic
/// member types were left open and bound with `T` still free, failing
/// argument/return/assignment conversions with GS0155 ("Cannot convert type
/// 'Holder' to 'Holder'"). The recursion must also handle nested generics,
/// arrays/nullables of generics, multiple type parameters, and inherited methods
/// (composing the base-chain mapping), while still rejecting wrong type arguments.
open class Issue1250GenericMemberSubstitutionBinderTests {
    @Fact
    func ConstructedGenericParameter_NoDiagnostic() {
        let source = `
class Holder[T]() { }
class Box[T]() { func Put(x Holder[T]) { } }
class C {
    func G(h Holder[int32]) {
        var b = Box[int32]()
        b.Put(h)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ConstructedGenericReturn_NoDiagnostic() {
        let source = `
class Holder[T]() { }
class Box[T]() { func Get() Holder[T] { return Holder[T]() } }
class C {
    func G() Holder[int32] {
        var b = Box[int32]()
        return b.Get()
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ConstructedGenericField_NoDiagnostic() {
        let source = `
class Holder[T]() { }
class Box[T]() { var Item Holder[T] = Holder[T]() }
class C {
    func G() Holder[int32] {
        var b = Box[int32]()
        return b.Item
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ConstructedGenericProperty_NoDiagnostic() {
        let source = `
class Holder[T]() { }
class Box[T]() { prop Item Holder[T] { get; set; } }
class C {
    func G(h Holder[int32]) {
        var b = Box[int32]()
        b.Item = h
        var read Holder[int32] = b.Item
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedConstructedGeneric_NoDiagnostic() {
        let source = `
class Holder[T]() { }
class Box[T]() { func Put(x Holder[Holder[T]]) { } }
class C {
    func G(h Holder[Holder[int32]]) {
        var b = Box[int32]()
        b.Put(h)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ArrayOfConstructedGeneric_NoDiagnostic() {
        let source = `
class Holder[T]() { }
class Box[T]() { func Put(x []Holder[T]) { } }
class C {
    func G(h []Holder[int32]) {
        var b = Box[int32]()
        b.Put(h)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NullableConstructedGeneric_NoDiagnostic() {
        let source = `
class Holder[T]() { }
class Box[T]() { func Put(x Holder[T]?) { } }
class C {
    func G(h Holder[int32]?) {
        var b = Box[int32]()
        b.Put(h)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func MultipleTypeParameters_NoDiagnostic() {
        let source = `
class Pair[K, V]() { }
class Map[K, V]() { func Put(x Pair[K, V]) { } }
class C {
    func G(p Pair[int32, string]) {
        var m = Map[int32, string]()
        m.Put(p)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InheritedMethodConstructedGenericParameter_NoDiagnostic() {
        // The constructed-generic parameter type `FilterBase[TOut]` is on an
        // INHERITED method; substitution must compose the inheritance mapping
        // TOut -> FrameEntry from the base chain
        // AudioFilter : TransformBase[FrameEntry, FrameEntry].
        let source = `
open class FilterBase[T]() { }
open class TransformBase[TIn, TOut] : FilterBase[TIn] {
    func LinkTo(next FilterBase[TOut]) { }
}
class FrameEntry { }
class AudioFilter : TransformBase[FrameEntry, FrameEntry] { }
class C {
    func G(arg FilterBase[FrameEntry]) {
        var f = AudioFilter()
        f.LinkTo(arg)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BareTypeParameterParameter_StillWorks_NoDiagnostic() {
        // Control / regression: a bare `T` parameter already substituted today.
        let source = `
class Box[T]() { func Put(x T) { } }
class C {
    func G() {
        var b = Box[int32]()
        b.Put(5)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ArrayOfTypeParameterParameter_StillWorks_NoDiagnostic() {
        // Control / regression: a `[]T` parameter already substituted today.
        let source = `
class Box[T]() { func Put(x []T) { } }
class C {
    func G(arr []int32) {
        var b = Box[int32]()
        b.Put(arr)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func WrongTypeArgument_UsesCallArgumentDiagnostic() {
        // Negative: Box[int32].Put expects Holder[int32]; passing Holder[string]
        // must still fail even though the display name 'Holder' matches.
        let source = `
class Holder[T]() { }
class Box[T]() { func Put(x Holder[T]) { } }
class C {
    func G(h Holder[string]) {
        var b = Box[int32]()
        b.Put(h)
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func WrongTypeArgument_Return_StillDiagnosticGS0155() {
        // Negative: Box[int32].Get returns Holder[int32], not Holder[string].
        let source = `
class Holder[T]() { }
class Box[T]() { func Get() Holder[T] { return Holder[T]() } }
class C {
    func G() Holder[string] {
        var b = Box[int32]()
        return b.Get()
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

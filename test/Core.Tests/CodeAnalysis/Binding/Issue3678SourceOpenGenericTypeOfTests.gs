// <copyright file="Issue3678SourceOpenGenericTypeOfTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #3678: the explicit-arity open-generic `typeof(Name[_, …])`
/// spelling (#1989) only ever searched REFERENCED assemblies, so it could not
/// name a generic type declared in the compilation being built —
/// `typeof(Slot[_])` over a source `class Slot[T]` reported GS0113
/// "Type 'Slot`1' doesn't exist" even though the bare `typeof(Slot)` form
/// bound it. Separately, the `ldtoken` emitted for ANY open user generic
/// definition (either spelling) took the generic-reference TypeSpec path,
/// producing a `Slot<!0>` TypeSpec whose VAR slot has no binding in
/// that scope; the PE then failed to load with BadImageFormatException the
/// moment the `typeof` ran. Both halves are covered here — the tests
/// EXECUTE the emitted program, so a metadata regression fails as loudly as a
/// binder one.
open class Issue3678SourceOpenGenericTypeOfTests {
    @Fact
    func SourceGenericClass_ExplicitArityTypeOf_BindsAndEmitsOpenDefinition() {
        let source = `
class Slot[T] {
    prop Value int32
}

typeof(Slot[_]).Name
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Slot`1", result.Value)
    }

    @Fact
    func SourceGenericClass_BareTypeOf_EmitsOpenDefinition() {
        let source = `
class Slot[T] {
    prop Value int32
}

typeof(Slot).Name
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Slot`1", result.Value)
    }

    @Fact
    func SourceGenericInterface_ExplicitArityTypeOf_BindsAndEmitsOpenDefinition() {
        let source = `
interface IQuery[T] {
}

typeof(IQuery[_]).Name
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("IQuery`1", result.Value)
    }

    @Fact
    func SourceGenericClass_TwoArityTypeOf_SelectsMatchingArity() {
        let source = `
class Pair[A, B] {
    prop V int32
}

typeof(Pair[_, _]).GetGenericArguments().Length
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func SourceOpenGenericTypeOf_IsGenericTypeDefinition() {
        let source = `
class Slot[T] {
    prop Value int32
}

typeof(Slot[_]).IsGenericTypeDefinition
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func SourceOpenGenericTypeOf_MakeGenericType_Constructs() {
        let source = `
class Slot[T] {
    prop Value int32
}

typeof(Slot[_]).MakeGenericType(typeof(int32)).GetGenericArguments()[0].Name
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Int32", result.Value)
    }

    @Fact
    func SourceGenericClass_WrongArityTypeOf_StillReportsUndefinedTypeGS0113() {
        let source = `
class Slot[T] {
    prop Value int32
}

class C {
    func run() {
        let t = typeof(Slot[_, _])
    }
}
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func ConstructedSourceGenericTypeOf_StaysConstructed() {
        let source = `
class Slot[T] {
    prop Value int32
}

typeof(Slot[int32]).GetGenericArguments()[0].Name
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Int32", result.Value)
    }
}

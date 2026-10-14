// <copyright file="Issue3677QualifiedNestedOpenGenericTypeOfTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #3677: the deferred remainder of #3678. The UNQUALIFIED explicit-arity
/// open-generic spelling (`typeof(Slot[_])`) now consults the declaration
/// table, but the QUALIFIED (`typeof(Fixtures.IQuery[_])`) and NESTED
/// (`typeof(Outer[_].Inner[_])`) spellings still resolved through
/// reflection names against the reference set alone, so a generic declared in
/// the compilation being built reported GS0113 "Type 'Fixtures.IQuery`1'
/// doesn't exist". Both spellings now fall back to a SOURCE walk — the head
/// segment through the ordinary source-type lookup, every later segment as a
/// nested type of the previously-resolved container — after the imported walks
/// miss, so an imported match still wins exactly as before.
///
/// As in #3678 the tests EXECUTE the emitted program, so the second half of
/// that fix (an `ldtoken` of an open user generic definition must take its
/// TypeDef row, not an unbound `Name<!0>` TypeSpec that fails to
/// load) is covered for the new spellings too.
open class Issue3677QualifiedNestedOpenGenericTypeOfTests {
    @Fact
    func QualifiedSourceGeneric_SingleArity_BindsAndEmitsOpenDefinition() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Fixtures.IQuery[_]).Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("IQuery`1", result.Value)
    }

    @Fact
    func QualifiedSourceGeneric_MultiArity_BindsAndEmitsOpenDefinition() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Fixtures.IChain[_, _, _, _]).Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("IChain`4", result.Value)
    }

    @Fact
    func QualifiedSourceGeneric_IsGenericTypeDefinition() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Fixtures.IQuery[_]).IsGenericTypeDefinition
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func QualifiedSourceGeneric_MakeGenericType_Constructs() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Fixtures.IQuery[_]).MakeGenericType(typeof(int32)).GetGenericArguments()[0].Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Int32", result.Value)
    }

    @Fact
    func NestedSourceGenericInsideGeneric_BindsAndEmitsOpenDefinition() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Outer[_].Inner[_]).Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Inner`1", result.Value)
    }

    @Fact
    func NestedSourceGenericInsideGeneric_CarriesEnclosingTypeParameters() {
        // The CLR gives a type nested in a generic its enclosing type's
        // parameters too, so `Outer`1+Inner`1` is an arity-2 definition —
        // exactly what C#'s `typeof(Outer<>.Inner<>)` yields.
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Outer[_].Inner[_]).GetGenericArguments().Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func NonGenericNestedInsideSourceGeneric_BindsAndEmitsOpenDefinition() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Outer[_].PlainInner).IsGenericTypeDefinition
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func NonGenericNestedInsideSourceGeneric_NamesTheNestedType() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Outer[_].PlainInner).Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("PlainInner", result.Value)
    }

    @Fact
    func QualifiedSourceGeneric_WrongArity_StillReportsUndefinedTypeGS0113() {
        let result = EmittedOracle.Evaluate(Fixtures + `
let t = typeof(Fixtures.IQuery[_, _])
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func QualifiedNonGenericSourceType_WithArity_StillReportsUndefinedTypeGS0113() {
        let result = EmittedOracle.Evaluate(Fixtures + `
let t = typeof(Fixtures.Plain[_])
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func QualifiedSourceGeneric_BogusQualifier_StillReportsUndefinedTypeGS0113() {
        let result = EmittedOracle.Evaluate(Fixtures + `
let t = typeof(Nonsense.Fixtures.IQuery[_])
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func NestedSourceGeneric_WrongOuterArity_StillReportsUndefinedTypeGS0113() {
        let result = EmittedOracle.Evaluate(Fixtures + `
let t = typeof(Outer[_, _].Inner[_])
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func UnqualifiedSourceGeneric_StillBinds() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Slot[_]).Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Slot`1", result.Value)
    }

    @Fact
    func BareSourceGeneric_StillBinds() {
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(Slot).Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Slot`1", result.Value)
    }

    @Fact
    func PackageQualifiedSourceGeneric_BindsThroughRelativeQualifier() {
        // The shape migrated code actually has: the C# `typeof(Fixtures.IQuery<>)`
        // qualifier is a NAMESPACE, spelled relative to the referencing package.
        let result = EmittedOracle.Evaluate([]string{`
package Demo.Fixtures3677

interface IQuery3677[T] {}
`, `
typeof(Fixtures3677.IQuery3677[_]).Name
`})
        Assert.Empty(result.Diagnostics)
        Assert.Equal("IQuery3677`1", result.Value)
    }

    @Fact
    func QualifiedImportedGeneric_StillWins() {
        // The imported reflection-name walk runs first and is unchanged: a
        // fully-qualified BCL generic keeps resolving from the reference set.
        let result = EmittedOracle.Evaluate(Fixtures + `
typeof(System.Collections.Generic.List[_]).Name
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("List`1", result.Value)
    }

    shared {
        private const Fixtures string = `
class Fixtures {
    interface IQuery[T] {}
    interface IChain[A, B, C, D] {}
    class Plain {}
}

class Outer[T] {
    class Inner[U] {}
    class PlainInner {}
}

class Slot[T] {
    prop Value int32
}
`
    }
}

// <copyright file="Issue1931GenericAbstractOverrideTests.cs" company="GSharp">
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

/// Issue #1931: an abstract (Issue #987 style no-body `open func`) GENERIC
/// method's own type parameter is a distinct (cref:TypeParameterSymbol)
/// instance from the overriding method's own same-named type parameter. Two
/// unrelated code paths compared those signatures without mapping the base
/// method's type parameter onto the override's: `SignaturesMatch` (used to
/// classify the `override` declaration itself) and
/// `StructSymbol.AbstractMethodSatisfiedBy` (used to decide whether a
/// concrete class still has unimplemented abstract members). Both saw the base's
/// `T` and the override's `T` as different types, so a `T?`-typed
/// parameter never compared equal — cascading into GS0185 (override signature
/// mismatch), which in turn left the abstract method looking unoverridden
/// (GS0387 on the class, GS0386 at the construction site). A third, unrelated
/// bug in generic-argument inference meant even a correctly-matched generic
/// method with only a `T?` parameter could never infer `T` from a plain
/// (non-nullable) argument, forcing every call site to spell out `[T]` (GS0151).
/// These tests verify all four clear together for the grid G08
/// `DefaultConstraint` fixture shape (a C# `where T : default`
/// override, which G# has no `where`-clause spelling for and represents as a
/// plain, unconstrained `[T]`).
open class Issue1931GenericAbstractOverrideTests {
    @Fact
    func GenericAbstractMethodOverride_WithNullableTypeParameter_BindsClean() {
        let source = `
open class MaybeShower {
    open func Show[T](value T?) string;
}

class PlainShower() : MaybeShower {
    override func Show[T](value T?) string {
        return "value"
    }
}

let s MaybeShower = PlainShower()
s.Show[string]("x")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("value", result.Value)
    }

    @Fact
    func GenericAbstractMethodOverride_InfersTypeArgumentFromNonNullableArgument() {
        // Issue #1931: the only parameter is `T?`; a plain `string` argument
        // (not itself `T?`) must still infer `T := string` (GS0151 regression).
        let source = `
open class MaybeShower {
    open func Show[T](value T?) string;
}

class PlainShower() : MaybeShower {
    override func Show[T](value T?) string {
        return "value"
    }
}

let s MaybeShower = PlainShower()
s.Show("x")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("value", result.Value)
    }

    @Fact
    func GenericAbstractMethodOverride_ConcreteClassConstructsCleanly() {
        // Regression guard for the GS0386/GS0387 cascade: constructing the
        // concrete override must not be rejected as "still abstract".
        let source = `
open class MaybeShower {
    open func Show[T](value T?) string;
}

class PlainShower() : MaybeShower {
    override func Show[T](value T?) string {
        return "value"
    }
}

PlainShower()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericAbstractMethodOverride_StillCatchesGenuineMismatch() {
        // A real signature mismatch (different arity) must still be rejected —
        // the fix maps type parameters onto each other, it does not disable the
        // rest of override validation.
        let source = `
open class MaybeShower {
    open func Show[T](value T?) string;
}

class BrokenShower() : MaybeShower {
    override func Show[T, U](value T?) string {
        return "value"
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0185")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

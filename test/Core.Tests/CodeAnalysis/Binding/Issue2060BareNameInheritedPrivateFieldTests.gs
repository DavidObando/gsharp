// <copyright file="Issue2060BareNameInheritedPrivateFieldTests.cs" company="GSharp">
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

/// Issue #2060 (follow-up to #2044/#2048): a bare (unqualified, no
/// `this.`/receiver) reference inside a derived class's method body that
/// names an inherited base field resolved via a binder-internal
/// (cref:Symbols.ImplicitFieldVariableSymbol) pseudo-variable that
/// bypassed `AccessibilityChecker` entirely. A base class's `private`
/// field was therefore both readable and writable by bare name from a derived
/// type with no diagnostic. `BindVariableReference` now runs every
/// resolved (cref:Symbols.ImplicitFieldVariableSymbol) through
/// `AccessibilityChecker.IsAccessible`, reporting GS0472 for both the
/// read and write paths — mirroring the qualified `receiver.field` checks
/// already in place. Inherited `protected` fields and a type's own
/// `private` fields (declared directly in the accessing type) remain
/// reachable by bare name with no diagnostic.
open class Issue2060BareNameInheritedPrivateFieldTests {
    @Fact
    func DerivedClass_BareNameReadOfInheritedPrivateField_ReportsGS0472() {
        let source = `
open class Base {
    private var Secret int32
}

class Derived : Base {
    func Poke() int32 {
        return Secret
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func DerivedClass_BareNameWriteOfInheritedPrivateField_ReportsGS0472() {
        let source = `
open class Base {
    private var Secret int32
}

class Derived : Base {
    func Poke() int32 {
        Secret = 42
        return 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func DerivedClass_BareNameOfInheritedProtectedField_NoDiagnostics() {
        // `protected` IS inherited-visible (unlike `private`): a derived
        // type's bare-name read/write of an inherited protected field must
        // keep compiling cleanly.
        let source = `
open class Base {
    protected var Secret int32
}

class Derived : Base {
    func Poke() int32 {
        Secret = 5
        return Secret
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func SameType_BareNameOfOwnPrivateField_NoDiagnostics() {
        // A type's own private field, declared directly in the same type as
        // the accessing code (not inherited), must remain legal by bare name.
        let source = `
class Foo {
    private var Secret int32
    func Poke() int32 {
        Secret = 5
        return Secret
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

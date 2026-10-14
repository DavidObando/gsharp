// <copyright file="Issue2044PrivateAccessibilityTests.cs" company="GSharp">
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

/// Issue #2044: a `private` member read or written from outside its
/// declaring type is now diagnosed (GS0472), mirroring the existing
/// `protected` enforcement (issue #950 / GS0379). Covers plain field
/// reads/writes, compound assignment (`+=`), null-coalescing assignment
/// (`??=`), and `private` properties — from outside the declaring
/// type (must report) and from inside it, including nested types of the same
/// top-level type (must not report).
open class Issue2044PrivateAccessibilityTests {
    @Fact
    func ExternalCode_WritesPrivateField_ReportsGS0472() {
        let source = `
class Foo {
    private var Secret int32
}

class Other {
    func Poke(f Foo) int32 {
        f.Secret = 42
        return f.Secret
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_ReadsPrivateField_ReportsGS0472() {
        let source = `
class Foo {
    private var Secret int32
}

class Other {
    func Poke(f Foo) int32 {
        return f.Secret
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_CompoundAssignsPrivateField_ReportsGS0472() {
        let source = `
class Foo {
    private var Secret int32
}

class Other {
    func Poke(f Foo) int32 {
        f.Secret += 1
        return f.Secret
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_NullCoalescingAssignsPrivateField_ReportsGS0472() {
        let source = `
class Foo {
    private var Secret int32?
}

class Other {
    func Poke(f Foo) int32? {
        f.Secret ??= 5
        return f.Secret
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_WritesPrivateProperty_ReportsGS0472() {
        let source = `
class Foo {
    private prop Secret int32 { get; set }
}

class Other {
    func Poke(f Foo) int32 {
        f.Secret = 3
        return f.Secret
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_WritesPrivateSetter_ReportsGS0472() {
        let source = `
class Foo {
    prop Value int32 { get; private set; }
}

class Other {
    func Poke(f Foo) {
        f.Value = 3
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func DeclaringType_WritesPrivateSetter_NoAccessibilityDiagnostic() {
        let source = `
class Foo {
    prop Value int32 { get; private set; }
    func Poke() {
        Value = 3
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func InternalCode_ReadsAndWritesPrivateFieldFromSameType_NoDiagnostics() {
        let source = `
class Foo {
    private var Secret int32
    func SetIt(v int32) int32 {
        Secret = v
        Secret += 1
        return Secret
    }
}

class Other {
    func Poke(f Foo) int32 {
        return f.SetIt(9)
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func NestedType_AccessesEnclosingTypePrivateField_NoDiagnostics() {
        // Issue #2044: `private` is visible throughout the enclosing
        // top-level type's body, including its nested types — mirroring C#'s
        // rule that private members are accessible anywhere within the
        // containing type.
        let source = `
class Outer {
    private var Secret int32

    class Inner {
        func Poke(o Outer) int32 {
            o.Secret = 7
            return o.Secret
        }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func DerivedClass_BareNameDoesNotSeeBasePrivateField() {
        // Issue #2060 (follow-up to #2044): a base class's private field is
        // not inherited, but a bare (unqualified) reference to it from a
        // derived type's method now reports the same inaccessible-member
        // diagnostic (GS0472) as the qualified `this.Secret` / `obj.Secret`
        // form, instead of the misleading "undefined variable" (GS0125) it
        // used to surface.
        let source = `
open class Base {
    private var Secret int32
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
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0125")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

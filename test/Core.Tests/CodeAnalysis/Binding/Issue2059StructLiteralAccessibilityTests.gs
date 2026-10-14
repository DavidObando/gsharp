// <copyright file="Issue2059StructLiteralAccessibilityTests.cs" company="GSharp">
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

/// Issue #2059: a composite/struct literal `Foo{ member: value }` writes
/// each named member directly (`BoundFieldInitializer`), bypassing the
/// qualified-assignment path (`receiver.field = value`) that #2044/#2048
/// already gate on `private`/`protected` accessibility (GS0472 /
/// GS0379). This closes the same gap for literal-init syntax.
open class Issue2059StructLiteralAccessibilityTests {
    @Fact
    func ExternalCode_LiteralInitsPrivateField_ReportsGS0472() {
        let source = `
class Foo {
    private var Secret int32
}

class Other {
    func Make() Foo {
        return Foo{ Secret: 5 }
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_LiteralInitsPrivateProperty_ReportsGS0472() {
        let source = `
class Foo {
    private prop Secret int32 { get; set }
}

class Other {
    func Make() Foo {
        return Foo{ Secret: 5 }
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func SameType_LiteralInitsOwnPrivateField_NoDiagnostics() {
        let source = `
class Foo {
    private var Secret int32

    func Make(v int32) Foo {
        return Foo{ Secret: v }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_LiteralInitsPublicField_NoDiagnostics() {
        let source = `
class Foo {
    var Visible int32
}

class Other {
    func Make() Foo {
        return Foo{ Visible: 5 }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_LiteralInitsInitOnlyProperty_NoDiagnostics() {
        let source = `
class Foo {
    prop Visible int32 { get; init }
}

class Other {
    func Make() Foo {
        return Foo{ Visible: 5 }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func DerivedType_LiteralInitsProtectedField_NoDiagnostics() {
        let source = `
open class Base {
    protected var Secret int32
}

class Derived : Base {
    func Make(v int32) Derived {
        return Derived{ Secret: v }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    @Fact
    func UnrelatedExternalCode_LiteralInitsProtectedField_ReportsGS0379() {
        let source = `
open class Base {
    protected var Secret int32
}

class Other {
    func Make() Base {
        return Base{ Secret: 5 }
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

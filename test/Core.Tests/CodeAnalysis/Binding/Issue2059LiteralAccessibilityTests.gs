// <copyright file="Issue2059LiteralAccessibilityTests.cs" company="GSharp">
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

/// Issue #2059: a composite/struct literal member initializer
/// (`Foo{ Secret: v }`), a `with`-expression field update
/// (`p with { Secret = v }`), and an object-initializer-suffix member
/// write (`Foo(){ Secret = v }`) are all writes to the named member —
/// each now enforces the same `protected`/`private` accessibility
/// rule as a plain assignment (issue #950 / #2044), reusing
/// (cref:Symbols.AccessibilityChecker.IsAccessible) and
/// (cref:DiagnosticBag.ReportMemberInaccessible).
open class Issue2059LiteralAccessibilityTests {
    @Fact
    func ExternalCode_StructLiteralInitsPrivateField_ReportsGS0472() {
        let source = `
class Foo {
    private var Secret int32
}

class Other {
    func Poke() int32 {
        let f = Foo{Secret: 42}
        return 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_StructLiteralInitsProtectedField_ReportsGS0379() {
        let source = `
open class Foo {
    protected var Secret int32
}

class Other {
    func Poke() int32 {
        let f = Foo{Secret: 42}
        return 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    @Fact
    func ExternalCode_StructLiteralInitsPrivateProperty_ReportsGS0472() {
        let source = `
class Foo {
    private prop Secret int32 { get; set }
}

class Other {
    func Poke() int32 {
        let f = Foo{Secret: 42}
        return 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func SameType_StructLiteralInitsPrivateField_NoDiagnostics() {
        let source = `
class Foo {
    private var Secret int32

    static func Make(v int32) Foo {
        return Foo{Secret: v}
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_StructLiteralInitsPublicField_NoDiagnostics() {
        let source = `
class Foo {
    var Value int32
}

class Other {
    func Poke() int32 {
        let f = Foo{Value: 42}
        return f.Value
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    @Fact
    func ExternalCode_WithExpressionUpdatesPrivateField_ReportsGS0472() {
        let source = `
data struct Point {
    private var x int32
    var y int32
}

class Other {
    func Poke(p Point) Point {
        return p with { x = 10 }
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func SameType_WithExpressionUpdatesPrivateField_NoDiagnostics() {
        let source = `
data struct Point {
    private var x int32
    var y int32

    func Bump() Point {
        return this with { x = 10 }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_ObjectInitializerSuffixWritesPrivateField_ReportsGS0472() {
        let source = `
class Foo {
    private var Secret int32
}

class Other {
    func Poke() int32 {
        let f = Foo(){Secret = 42}
        return 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

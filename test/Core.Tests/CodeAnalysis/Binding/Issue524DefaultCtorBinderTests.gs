// <copyright file="Issue524DefaultCtorBinderTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #524 — focused binder coverage. A `class X { ... }` whose
/// body declares fields (but no explicit `init(...)` and no primary
/// constructor) must surface a synthesized parameterless default constructor
/// at the call site: `X()` must bind cleanly, with no diagnostics, and
/// reject any non-zero argument count with a clean diagnostic against the
/// class name. The same applies to imported CLR value types — `T()`
/// must always bind for a `System.ValueType` subclass (other than
/// enum/primitive) because the CLR provides every `struct` with an
/// implicit zero-initialising default ctor (`initobj` in IL).
open class Issue524DefaultCtorBinderTests {
    @Fact
    func GSharpClass_NoInit_CallExpression_BindsCleanly() {
        let source = `
class Holder {
    var Value int32
}

var h = Holder()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GSharpClass_NoInit_WrongArgCount_ReportsWrongArgumentCount() {
        // The synthesised default ctor accepts zero arguments. A positional
        // argument should be reported against the class name — not as a
        // missing function or a failing conversion.
        let source = `
class Holder {
    var Value int32
}

var h = Holder(7)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Holder"))
        // Must NOT report 'Holder' as a missing function — that was the
        // pre-fix shape (GS0130). We expect the binder to route through the
        // constructor-call path and emit a wrong-argument-count diagnostic.
        Assert.DoesNotContain(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("Function 'Holder' doesn't exist")
        )
    }

    @Fact
    func GSharpClass_EmptyBody_DefaultConstructor_BindsCleanly() {
        let source = `
class Empty { }

var e = Empty()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GSharpClass_ExplicitInit_Unchanged() {
        // Regression guard: classes that DO declare an explicit init(...)
        // must continue to bind against that constructor's parameter list.
        let source = `
class Point {
    var X int32
    var Y int32

    init(x int32, y int32) {
        X = x
        Y = y
    }
}

var p = Point(3, 4)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GSharpClass_PrimaryCtor_Unchanged() {
        // Regression guard: primary-ctor classes must keep binding.
        let source = `
class Box(value int32) { }

var b = Box(42)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClrStruct_NoExplicitCtor_BindsCleanly_HashCode() {
        // System.HashCode is a public BCL value type with no public
        // constructors at all. Per the CLR contract, every value type has
        // an implicit zero-initialising default ctor; the binder must
        // route `HashCode()` through that synthetic path.
        let source = `
import System

var h = HashCode()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClrStruct_WithExplicitCtor_DefaultStillBinds_TimeSpan() {
        // Regression guard: a CLR struct that declares an explicit ctor
        // must still also accept a zero-argument default construction, the
        // same way `new TimeSpan()` compiles in C#.
        let source = `
import System

var zero = TimeSpan()
var oneHour = TimeSpan(1, 0, 0)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClrClass_WithDefaultCtor_StillBinds_StringBuilder() {
        // The #524 fallback fires only for value types; reference-type
        // constructor resolution must be unchanged.
        let source = `
import System.Text

var sb = StringBuilder()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClrAbstractClass_DefaultCall_StillFails() {
        // Regression guard for the value-type gating: abstract reference
        // types must NOT be magically constructible — the value-type
        // fallback added in #524 is gated on `IsValueType` precisely to
        // avoid accidentally enabling `new AbstractClass()`.
        let source = `
import System.IO

var s = Stream()
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

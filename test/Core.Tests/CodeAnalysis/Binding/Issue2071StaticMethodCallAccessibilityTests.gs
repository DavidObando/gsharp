// <copyright file="Issue2071StaticMethodCallAccessibilityTests.cs" company="GSharp">
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

/// Issue #2071:
/// (cref:GSharp.Core.CodeAnalysis.Binding.ExpressionBinder.BindUserTypeStaticCall(TypeSymbol,
/// CallExpressionSyntax))
/// never consulted (cref:AccessibilityChecker.IsAccessible) at all, so
/// a `private`/`protected` static (`shared`) method called
/// from outside its declaring type was never diagnosed — the same class of
/// hole that #2058/#2062 fixed for instance-method calls
/// (`OverloadResolver.BindUserInstanceCall`), but left open for
/// `TypeName.Method()` static calls.
open class Issue2071StaticMethodCallAccessibilityTests {
    @Fact
    func ExternalCode_CallsPrivateStaticMethod_ReportsGS0472() {
        let source = `
class Foo {
    shared {
        private func Secret() int32 {
            return 42
        }
    }
}

class Other {
    func Poke() int32 {
        return Foo.Secret()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_CallsProtectedStaticMethod_ReportsGS0379NotGS0472() {
        let source = `
open class Base {
    shared {
        protected func Guarded() int32 {
            return 7
        }
    }
}

class Other {
    func Poke() int32 {
        return Base.Guarded()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func DerivedClass_CallsBaseProtectedStaticMethod_NoDiagnostics() {
        let source = `
open class Base {
    shared {
        protected func Guarded() int32 {
            return 7
        }
    }
}

class Derived : Base {
    func Poke() int32 {
        return Base.Guarded()
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func InternalCode_CallsPrivateStaticMethodFromSameType_NoDiagnostics() {
        let source = `
class Foo {
    shared {
        private func Secret() int32 {
            return 42
        }

        func Reveal() int32 {
            return Secret()
        }
    }
}

class Other {
    func Poke() int32 {
        return Foo.Reveal()
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_CallsPublicStaticMethod_NoDiagnostics() {
        let source = `
class Foo {
    shared {
        func Open() int32 {
            return 42
        }
    }
}

class Other {
    func Poke() int32 {
        return Foo.Open()
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

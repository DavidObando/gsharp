// <copyright file="Issue2067PrivateConstructorAccessibilityTests.cs" company="GSharp">
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

/// Issue #2067 (follow-up from #2065 / #2058): an explicit `init(...)`
/// constructor resolves through a separate binder path from regular method
/// calls, so (cref:AccessibilityChecker.IsAccessible) was never
/// consulted there — a `private`/`protected` constructor called
/// from outside its declaring type went undiagnosed at compile time (the CLR
/// would still reject it at runtime). Mirrors
/// `Issue2058PrivateMethodCallAccessibilityTests` for constructors.
open class Issue2067PrivateConstructorAccessibilityTests {
    @Fact
    func ExternalCode_CallsPrivateConstructor_ReportsGS0472() {
        let source = `
class Foo {
    private init() {}
}

class Other {
    func Make() Foo {
        return Foo()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_CallsProtectedConstructor_ReportsGS0379NotGS0472() {
        let source = `
open class Base {
    protected init() {}
}

class Other {
    func Make() Base {
        return Base()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func InternalCode_CallsPrivateConstructorFromSameType_NoDiagnostics() {
        let source = `
class Foo {
    private init() {}

    func Make() Foo {
        return Foo()
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func DerivedClass_CallsBaseProtectedConstructor_NoDiagnostics() {
        let source = `
open class Base {
    protected init() {}
}

class Derived : Base {
    init() : base() {}
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_CallsPublicConstructor_NoDiagnostics() {
        let source = `
class Foo {
    init() {}
}

class Other {
    func Make() Foo {
        return Foo()
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

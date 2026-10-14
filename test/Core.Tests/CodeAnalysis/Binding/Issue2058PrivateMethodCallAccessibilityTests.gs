// <copyright file="Issue2058PrivateMethodCallAccessibilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2058: (cref:OverloadResolver.BindUserInstanceCall)
/// previously only consulted (cref:AccessibilityChecker.IsAccessible)
/// when a called method's accessibility was exactly `protected`, so a
/// `private` method called from outside its declaring type was never
/// diagnosed — the same class of hole that issue #2044 fixed for field/
/// property reads and writes, but left open for method calls. This mirrors
/// `Issue2044PrivateAccessibilityTests`, but exercises method calls
/// specifically.
open class Issue2058PrivateMethodCallAccessibilityTests {
    @Fact
    func ExternalCode_CallsPrivateMethod_ReportsGS0472() {
        let source = `
class Foo {
    private func Secret() int32 {
        return 42
    }
}

class Other {
    func Poke(f Foo) int32 {
        return f.Secret()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_CallsPrivateMethodViaChainedReceiver_ReportsGS0472() {
        // Issue #2058: same gated path, but reached through a chained member
        // access (`Make().Secret()`) rather than a bare parameter receiver.
        let source = `
class Foo {
    private func Secret() int32 {
        return 42
    }
}

class Other {
    func Make() Foo {
        return Foo()
    }

    func Poke() int32 {
        return Make().Secret()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func InternalCode_CallsPrivateMethodFromSameType_NoDiagnostics() {
        let source = `
class Foo {
    private func Secret() int32 {
        return 42
    }

    func Reveal() int32 {
        return Secret()
    }
}

class Other {
    func Poke(f Foo) int32 {
        return f.Reveal()
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func NestedType_CallsEnclosingTypePrivateMethod_NoDiagnostics() {
        let source = `
class Outer {
    private func Secret() int32 {
        return 42
    }

    class Inner {
        func Poke(o Outer) int32 {
            return o.Secret()
        }
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func DerivedClass_CallsBaseProtectedMethod_NoDiagnostics() {
        // A derived class calling its base's `protected` method must still
        // compile cleanly — the private-method fix must not accidentally
        // over-broaden the check to also require `protected` methods be
        // publicly visible.
        let source = `
open class Base {
    protected func Guarded() int32 {
        return 7
    }
}

class Derived : Base {
    func Poke() int32 {
        return Guarded()
    }
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    @Fact
    func ExternalCode_CallsProtectedMethod_ReportsGS0379NotGS0472() {
        // Issue #2058: the diagnostic reporter must be passed the member's
        // real accessibility, not a hardcoded `protected`, so a `protected`
        // method still reports GS0379 (not GS0472) once the gate covers all
        // non-public accessibilities.
        let source = `
open class Base {
    protected func Guarded() int32 {
        return 7
    }
}

class Other {
    func Poke(b Base) int32 {
        return b.Guarded()
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0379")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0472")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

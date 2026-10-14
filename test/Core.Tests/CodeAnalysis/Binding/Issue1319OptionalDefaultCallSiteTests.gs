// <copyright file="Issue1319OptionalDefaultCallSiteTests.cs" company="GSharp">
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

/// Issue #1319 (ADR-0063 follow-up): a call to a user-defined <em>instance</em>
/// method or constructor must honor declared parameter defaults when trailing
/// optional arguments are omitted at the call site. Before the fix, only
/// top-level functions, static (`shared`) methods, and constructors
/// consumed the captured defaults; instance-method calls (both implicit-`this`
/// and explicit-receiver) wrongly reported GS0144 ("requires N arguments").
open class Issue1319OptionalDefaultCallSiteTests {
    @Fact
    func InstanceMethod_TrailingOptionalOmitted_ViaReceiver_UsesDefault() {
        let source = `
class C {
    func F(x int32 = 7) int32 { return x }
}

var c = C()
c.F()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func InstanceMethod_TrailingOptionalSupplied_ViaReceiver_UsesArgument() {
        let source = `
class C {
    func F(x int32 = 7) int32 { return x }
}

var c = C()
c.F(5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func InstanceMethod_ImplicitThis_TrailingOptionalOmitted_UsesDefault() {
        let source = `
class C {
    func F(x int32 = 9) int32 { return x }
    func G() int32 { return F() }
}

var c = C()
c.G()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func InstanceMethod_MultipleTrailingOptionals_OmitOne_UsesDefault() {
        let source = `
class C {
    func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
}

var c = C()
c.F(10, 20)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(32, result.Value)
    }

    @Fact
    func InstanceMethod_MultipleTrailingOptionals_OmitAll_UsesDefaults() {
        let source = `
class C {
    func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
}

var c = C()
c.F(10)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(13, result.Value)
    }

    @Fact
    func InstanceMethod_MultipleTrailingOptionals_AllSupplied_UsesArguments() {
        let source = `
class C {
    func F(a int32, b int32 = 1, c int32 = 2) int32 { return a + b + c }
}

var c = C()
c.F(10, 20, 30)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(60, result.Value)
    }

    @Fact
    func Constructor_TrailingOptionalOmitted_UsesDefault() {
        let source = `
class C {
    var X int32
    init(x int32 = 100) { X = x }
}

var c = C()
c.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(100, result.Value)
    }

    @Fact
    func InstanceMethod_TooFewRequiredArguments_StillDiagnosesGS0144() {
        // The required (non-optional) leading parameter `a` is still mandatory.
        let source = `
class C {
    func F(a int32, b int32 = 1) int32 { return a + b }
}

var c = C()
c.F()
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0144")
    }

    @Fact
    func InstanceMethod_TooManyArguments_StillDiagnosesGS0144() {
        let source = `
class C {
    func F(a int32, b int32 = 1) int32 { return a + b }
}

var c = C()
c.F(1, 2, 3)
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0144")
    }

    @Fact
    func InstanceMethod_OverloadResolution_ExactArityNotPenalized() {
        // An exact-arity overload must win over a defaulted-slot candidate so
        // existing passing code is not made ambiguous by the new behavior.
        let source = `
class C {
    func F(a int32) int32 { return a }
    func F(a int32, b int32 = 100) int32 { return a + b }
}

var c = C()
c.F(5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func InstanceMethod_StringDefault_TrailingOptionalOmitted_UsesDefault() {
        let source = `
class C {
    func Tag(s string = "hello") string { return s }
}

var c = C()
c.Tag()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hello", result.Value)
    }

    shared {
        private func AssertHasDiagnosticId(diagnostics IEnumerable[Diagnostic], id string) {
            for diagnostic in diagnostics {
                if diagnostic.Id == id {
                    return
                }
            }
            Assert.Fail("Expected diagnostic '$id' was not reported.")
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

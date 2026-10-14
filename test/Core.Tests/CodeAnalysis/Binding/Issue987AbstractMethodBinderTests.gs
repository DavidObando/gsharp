// <copyright file="Issue987AbstractMethodBinderTests.cs" company="GSharp">
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

/// Issue #987: binder tests for abstract members. A no-body
/// `open func F() R;` on an `open class` is the canonical G# spelling
/// of a C# `abstract` method. These tests verify that the declaration no
/// longer crashes the binder (the original GS9998 ICE), that a concrete derived
/// class overriding it binds cleanly with working virtual dispatch, and that the
/// GS0386 / GS0387 / GS0388 diagnostics fire on the expected ill-formed inputs.
open class Issue987AbstractMethodBinderTests {
    @Fact
    func AbstractMethodDeclaration_NoIce_BindsClean() {
        let source = `
open class Shape {
    open func Area() float64;
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ConcreteOverride_ResolvesAndDispatchesVirtually() {
        let source = `
open class Shape {
    open func Area() float64;
}

class Circle(R float64) : Shape {
    override func Area() float64 { return 3.0 * R * R }
}

let s Shape = Circle(2.0)
s.Area()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12.0, result.Value)
    }

    @Fact
    func AbstractMethod_WithParameters_BindsAndDispatches() {
        let source = `
open class Animal {
    open func Speak(n int32) int32;
}

class Dog() : Animal {
    override func Speak(n int32) int32 { return n + 1 }
}

let a Animal = Dog()
a.Speak(41)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConstructingAbstractType_DiagnosticGS0386() {
        let source = `
open class Shape {
    open func Area() float64;
}

let bad = Shape()
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0386")
    }

    @Fact
    func ConcreteDerivedMissingOverride_DiagnosticGS0387() {
        let source = `
open class Shape {
    open func Area() float64;
}

class Circle(R float64) : Shape {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0387")
    }

    @Fact
    func OpenDerivedMayLeaveAbstract_NoDiagnostic() {
        let source = `
open class Shape {
    open func Area() float64;
}

open class Mid : Shape {
}
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0387")
    }

    @Fact
    func AbstractMethodInNonOpenClass_DiagnosticGS0388() {
        let source = `
class Shape {
    open func Area() float64;
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0388")
    }

    @Fact
    func BodylessMethodWithoutOpen_DiagnosticGS0388() {
        let source = `
open class Shape {
    func Area() float64;
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0388")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

// <copyright file="Issue986BaseClassCallBinderTests.cs" company="GSharp">
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

/// Issue #986: Emitted-oracle coverage for base class call.
/// Traceability: diagnostics GS0383, GS0384 and GS0385.
open class Issue986BaseClassCallBinderTests {
    @Fact
    func BaseDotCall_ResolvesAndRuns() {
        let source = `
open class Shape {
    open func Describe() string { return "shape" }
}

class Circle() : Shape {
    override func Describe() string { return base.Describe() + " circle" }
}

var c = Circle()
c.Describe()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("shape circle", result.Value)
    }

    @Fact
    func BaseBracketCall_ResolvesAndRuns() {
        let source = `
open class Shape {
    open func Describe() string { return "shape" }
}

class Circle() : Shape {
    override func Describe() string { return base[Shape].Describe() + " circle" }
}

var c = Circle()
c.Describe()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("shape circle", result.Value)
    }

    @Fact
    func BaseCall_WithParametersAndReturn() {
        let source = `
open class Adder {
    open func Add(a int32, b int32) int32 { return a + b }
}

class LoggingAdder() : Adder {
    override func Add(a int32, b int32) int32 { return base.Add(a, b) + 100 }
}

var x = LoggingAdder()
x.Add(2, 3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(105, result.Value)
    }

    @Fact
    func BaseCall_ReachesGrandparentImplementation() {
        let source = `
open class A {
    open func Name() string { return "A" }
}

open class B() : A {
}

class C() : B {
    override func Name() string { return base.Name() + "C" }
}

var c = C()
c.Name()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("AC", result.Value)
    }

    @Fact
    func BaseCall_OutsideDerivedInstanceMember_DiagnosticGS0383() {
        let source = `
func standalone() string {
    return base.ToString()
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0383")
    }

    @Fact
    func BaseCall_NoBaseClass_MemberNotFound_DiagnosticGS0384() {
        // Issue #1260: a class deriving only from System.Object now treats
        // System.Object as its base (so base.ToString() etc. work). A base call
        // naming a member that does NOT exist on object is therefore a
        // member-not-found error (GS0384), matching C# CS0117 — not the
        // "no base class" GS0383.
        let source = `
class Solo() {
    func Describe() string { return base.Describe() }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0384")
    }

    @Fact
    func BaseCall_MemberNotOnBase_DiagnosticGS0384() {
        let source = `
open class Shape {
    open func Describe() string { return "shape" }
}

class Circle() : Shape {
    override func Describe() string { return base.NotAMember() }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0384")
    }

    @Fact
    func BaseBracket_NotABaseClass_DiagnosticGS0385() {
        let source = `
open class Shape {
    open func Describe() string { return "shape" }
}

open class Other {
    open func Describe() string { return "other" }
}

class Circle() : Shape {
    override func Describe() string { return base[Other].Describe() }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0385")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

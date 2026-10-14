// <copyright file="Issue4350GetOnlyAutoPropertyBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #4350: a get-only auto-property (`prop P T { get; }`) is
/// assignable exactly where C# allows it — inside the declaring type's
/// instance constructor, on the instance being constructed — and stays
/// read-only (GS0127) everywhere else.
open class Issue4350GetOnlyAutoPropertyBindingTests {
    @Fact
    func DeclaringConstructor_MayAssignBareThisCompoundAndIncrement() {
        let result = EmittedOracle.Evaluate(`struct S {
    init(n int32) {
        Length = n
        this.Capacity = n * 2
        Length += 1
        Capacity++
    }
    prop Length int32 { get; }
    prop Capacity int32 { get; }
}

let s = S(3)
s.Length * 100 + s.Capacity`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(407, result.Value)
    }

    @Fact
    func GenericClassConstructor_MayAssign() {
        let result = EmittedOracle.Evaluate(`class Box[T] {
    init(value T) {
        Value = value
    }
    prop Value T { get; }
}

Box[string]("boxed").Value`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("boxed", result.Value)
    }

    @Fact
    func OrdinaryMethod_StaysReadOnly() {
        let diagnostics = EmittedOracle.Evaluate(`class C {
    init() {
        Value = 1
    }
    prop Value int32 { get; }
    func Reset() {
        Value = 0
    }
}`).Diagnostics
        Assert.Single(diagnostics.Where((d Diagnostic) -> d.Id == "GS0127"))
    }

    @Fact
    func DerivedConstructor_CannotAssignBaseProperty() {
        let diagnostics = EmittedOracle.Evaluate(`open class Base {
    init() {
        Name = "base"
    }
    prop Name string { get; }
}

class Derived : Base {
    init() : base() {
        Name = "derived"
    }
}`).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func LambdaInsideConstructor_CannotAssign() {
        let diagnostics = EmittedOracle.Evaluate(`import System

class C {
    init() {
        let set = () -> {
            Value = 2
        }
        set()
    }
    prop Value int32 { get; }
}`).Diagnostics
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func OtherInstanceInsideConstructor_CannotAssign() {
        let diagnostics = EmittedOracle.Evaluate(`class C {
    init(other C?) {
        Value = 1
        if other != nil {
            other.Value = 2
        }
    }
    prop Value int32 { get; }
}`).Diagnostics
        Assert.Single(diagnostics.Where((d Diagnostic) -> d.Id == "GS0127"))
    }
}

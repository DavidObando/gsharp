// <copyright file="MethodWithReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Linq
import Xunit

/// Phase 6.4 — instance methods on same-package user-defined types.
/// @remarks ADR-0182 (issue #4240) retired the receiver-clause spelling for owned
/// instance methods: `func (r T) M() { ... }` is unconditionally an
/// extension now, regardless of whether the current package owns `T`.
/// The in-body form (`class T { func M() { ... } }` /
/// `struct T { func M() { ... } }`) is the only spelling for an owned
/// instance method. Receiver-clause behavior — including the "does this
/// collide with an in-body method of the same name" question, which it no
/// longer does — is covered by `OwnedReceiverWarningTests`.
open class MethodWithReceiverTests {
    @Fact
    func InBodyMethod_OnStruct_BindsAndDispatches() {
        let source = `
struct Point {
    var X int32
    var Y int32

    func Distance() int32 {
        return X * X + Y * Y
    }
}

var p = Point{X: 3, Y: 4}
p.Distance()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(25, result.Value)
    }

    @Fact
    func InBodyMethod_OnClass_BindsAndDispatches() {
        let source = `
class Point {
    var X int32
    var Y int32

    func Distance() int32 {
        return X * X + Y * Y
    }
}

var p = Point{X: 6, Y: 8}
p.Distance()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(100, result.Value)
    }

    @Fact
    func InBodyMethod_ComposesWithOtherMethodsOnSameType() {
        let source = `
struct Point {
    var X int32
    var Y int32

    func Sum() int32 { return X + Y }
    func DoubleSum() int32 { return Sum() * 2 }
}

var p = Point{X: 5, Y: 7}
p.DoubleSum()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(24, result.Value)
    }

    @Fact
    func CrossPackageReceiver_RemainsExtensionFunction() {
        let definingTree = SyntaxTree.Parse(SourceText.From(`
package Geometry
public struct Point {
    var X int32
}
`))
        let extensionTree = SyntaxTree.Parse(SourceText.From(`
package Extensions
func (p Point) Next() int32 { return p.X + 1 }
`))
        let compilation = Compilation(definingTree, extensionTree)
        let function = compilation.GlobalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Next")
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.True(function.IsExtension)
        Assert.IsType[StructSymbol](function.ExtensionReceiverType)
        Assert.Null(function.ReceiverType)
    }

    @Fact
    func InBodyMethod_BareFieldAccess_UsesImplicitThis() {
        let source = `
struct Counter {
    var Value int32

    func Inc() int32 {
        return Value + 1
    }
}

var c = Counter{Value: 41}
c.Inc()
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(42, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

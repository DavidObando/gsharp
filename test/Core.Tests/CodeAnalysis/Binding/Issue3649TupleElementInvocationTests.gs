// <copyright file="Issue3649TupleElementInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3649 — direct invocation of a function-typed tuple element:
/// `t.f(10)`. Witness of discrimination: before the fix the call binder
/// treated `t.f` as a METHOD lookup on the tuple's CLR backing
/// (`ValueTuple`) and reported "Cannot find function f", even though
/// reading the element (`let a = t.f`) and invoking the local worked.
open class Issue3649TupleElementInvocationTests {
    @Fact
    func NamedElement_DirectInvocation_IssueRepro() {
        let result = EmittedOracle.Evaluate(`
let t = (f: (x int32) -> x + 1, g: () -> 5)
let r2 = t.f(10)
r2
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(11, result.Value)
    }

    @Fact
    func NamedElements_DirectInvocation_BothElements() {
        let result = EmittedOracle.Evaluate(`
let t = (f: (x int32) -> x + 1, g: () -> 5)
t.f(10) + t.g()
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(16, result.Value)
    }

    @Fact
    func PositionalItemSelector_DirectInvocation() {
        let result = EmittedOracle.Evaluate(`
let t = ((x int32) -> x + 1, (x int32) -> x * 2)
t.Item1(10) + t.Item2(3)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(17, result.Value)
    }

    @Fact
    func NamedElement_DeclaredTupleType_DirectInvocation() {
        let result = EmittedOracle.Evaluate(`
func mk() (f (int32) -> int32, g () -> int32) {
    return ((x int32) -> x - 1, () -> 7)
}

let t = mk()
t.f(10) + t.g()
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(16, result.Value)
    }

    @Fact
    func NestedAccess_TupleMemberOfClass_DirectInvocation() {
        let result = EmittedOracle.Evaluate(`
class Holder {
    var t (f (int32) -> int32, n int32)
}

let x = Holder()
x.t = ((v int32) -> v + 1, 0)
x.t.f(10)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(11, result.Value)
    }

    @Fact
    func DelegateTypedElement_NamedSelector_DirectInvocation() {
        let result = EmittedOracle.Evaluate(`
let t (h System.Func[int32, int32], n int32) = ((x int32) -> x + 1, 0)
t.h(10)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(11, result.Value)
    }

    @Fact
    func DelegateTypedElement_ItemSelector_DirectInvocation() {
        let result = EmittedOracle.Evaluate(`
let t (System.Func[int32, int32], int32) = ((x int32) -> x + 1, 0)
t.Item1(10)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(11, result.Value)
    }

    @Fact
    func ElementRead_ThenInvoke_StillWorks() {
        let result = EmittedOracle.Evaluate(`
let t = (f: (x int32) -> x + 1, g: () -> 5)
let a = t.f
a(10)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(11, result.Value)
    }

    @Fact
    func NonCallableNamedElement_ReportsNotAFunction() {
        let result = EmittedOracle.Evaluate(`
let t = (f: 41, g: 0)
t.f(1)
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }
}

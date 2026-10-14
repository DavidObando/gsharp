// <copyright file="NestedNamedTupleProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// ADR-0172 projection-gate family: a named tuple nested INSIDE a generic
/// type argument (`List[List[(a int32, b string)]]`, `List[[](a, b)]`)
/// shares its CLR backing with the unnamed shape, so every keep-symbolic
/// decision along the construction/indexing chain must treat
/// named-tuple-bearing arguments as symbolic — otherwise the element names
/// erase and member access by name fails GS0158. This was the 2026-08-29
/// selfmig nightly wall: cs2gs (post-#3623) emits `candidate[0].Symbol`
/// against `List[List[(syntax …, symbol …)]]` in
/// CSharpToGSharpTranslator.Constructors.gs, which cascaded compile
/// failures into every app referencing migrated Cs2Gs projects.
open class NestedNamedTupleProjectionTests {
    @Fact
    func ListOfListOfNamedTuple_IndexChain_ResolvesNames() {
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

func run() int32 {
    let groups = List[List[(a int32, b string)]]()
    let inner = List[(a int32, b string)]()
    inner.Add((a: 1, b: "x"))
    groups.Add(inner)
    let picked = groups[0]
    return groups[0][0].a + picked[0].a
}
run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func ListOfSliceOfNamedTuple_IndexChain_ResolvesNames() {
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

func run() int32 {
    let a = List[[](a int32, b string)]()
    a.Add([](a int32, b string){(a: 41, b: "x")})
    return a[0][0].a
}
run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(41, result.Value)
    }

    @Fact
    func ForInOverListOfListOfNamedTuple_MemberOnIndexedElement_Resolves() {
        // The exact selfmig shape: iterate the outer list, index the inner,
        // read a named element, then use the result as a typed receiver.
        let result = EmittedOracle.Evaluate(`
import System
import System.Collections.Generic

func run() int32 {
    let groups = List[List[(syntax string, symbol IComparable)]]()
    let inner = List[(syntax string, symbol IComparable)]()
    inner.Add((syntax: "s", symbol: 3))
    groups.Add(inner)
    var found = 0
    for candidate in groups {
        let head = candidate[0].symbol
        found = found + head.CompareTo(3)
    }
    return found
}
run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func DictionaryOfNamedTupleValues_IndexerResolvesNames() {
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

func run() int32 {
    let table = Dictionary[string, (count int32, label string)]()
    table["k"] = (count: 7, label: "x")
    return table["k"].count
}
run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }
}

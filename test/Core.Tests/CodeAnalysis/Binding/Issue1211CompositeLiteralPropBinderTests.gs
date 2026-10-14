// <copyright file="Issue1211CompositeLiteralPropBinderTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #1211: a composite literal `T{Field: value}` must resolve and
/// assign settable `prop` auto-property members (a property with a
/// `set` or an `init` accessor) — not just `var` fields. A
/// get-only property is still not settable, so targeting it stays a diagnostic.
open class Issue1211CompositeLiteralPropBinderTests {
    @Fact
    func CompositeLiteral_GetInitProperty_Binds() {
        let source = `
class C { prop TrackId int32 { get; init; } }
let c = C{TrackId: 7}
c.TrackId
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func CompositeLiteral_GetSetProperty_Binds() {
        let source = `
class C { prop Count int32 { get; set } }
let c = C{Count: 9}
c.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func CompositeLiteral_MixedPropAndVar_Binds() {
        let source = `
class E { prop Name int32 { get; set } var Count int32 }
let e = E{Name: 3, Count: 4}
e.Name + e.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func CompositeLiteral_InheritedProperty_Binds() {
        let source = `
open class Base { prop Id int32 { get; init; } }
class Derived : Base { prop Extra int32 { get; set } }
let d = Derived{Id: 5, Extra: 6}
d.Id + d.Extra
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func CompositeLiteral_StructProperty_Binds() {
        let source = `
struct P { prop X int32 { get; init; } prop Y int32 { get; set } var Z int32 }
let p = P{X: 1, Y: 2, Z: 3}
p.X + p.Y + p.Z
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func CompositeLiteral_GetOnlyProperty_IsDiagnosed() {
        let source = `
class C { prop Ro int32 { get; } }
let c = C{Ro: 1}
c.Ro
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("read-only"))
    }

    @Fact
    func CompositeLiteral_UnknownMember_IsDiagnosed() {
        let source = `
class C { prop Name int32 { get; set } }
let c = C{Missing: 1}
c.Name
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot find member"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

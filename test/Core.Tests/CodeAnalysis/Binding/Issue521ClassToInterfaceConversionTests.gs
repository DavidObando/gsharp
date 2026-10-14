// <copyright file="Issue521ClassToInterfaceConversionTests.cs" company="GSharp">
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

/// Issue #521: the binder used to reject a concrete-class → implemented-interface
/// assignment with `GS0155` for every CLR-typed shape (e.g.
/// `List<string>` to `IReadOnlyList<string>`) because the
/// reference-upcast rule in (cref:Conversion.Classify) only walked the
/// G# class (cref:StructSymbol.Interfaces) list. The fix layers a
/// general CLR-reference upcast on top so the binder accepts any
/// `from.ClrType` → `to.ClrType` that
/// (cref:ClrTypeUtilities.IsAssignableByName) reports as
/// assignment-compatible, covering BCL classes, CLR interfaces, and the
/// user-class → user-interface path that already worked.
///
/// Scope tested here (binder classification only; the emit + execute shape
/// lives in `Issue521ClassToInterfaceUpcastEmitTests`):
/// - G# class implementing G# interface — assignment, argument passing, return widening, explicit cast.
/// - CLR class implementing CLR interface — `List<T>` to `IReadOnlyList<T>`, `IEnumerable<T>`, and
/// `ICollection<T>`.
/// - CLR class implementing CLR interface — `string` to `IComparable`.
/// - Negative: assigning an unrelated reference type still produces a precise `GS0155`.
open class Issue521ClassToInterfaceConversionTests {
    @Fact
    func GSharpClass_To_GSharpInterface_Assignment_Binds() {
        let source = `
interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return "Hello, " + name }
}

var g IGreeter = HelloGreeter{}
g.Greet("world")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Hello, world", result.Value)
    }

    @Fact
    func GSharpClass_To_GSharpInterface_AsArgument_Binds() {
        let source = `
interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return "Hi, " + name }
}

func Run(g IGreeter, name string) string {
    return g.Greet(name)
}

Run(HelloGreeter{}, "ada")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Hi, ada", result.Value)
    }

    @Fact
    func GSharpClass_To_GSharpInterface_AsReturnType_Binds() {
        let source = `
interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return "Hey, " + name }
}

func Make() IGreeter {
    return HelloGreeter{}
}

Make().Greet("bob")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Hey, bob", result.Value)
    }

    @Fact
    func GSharpClass_To_GSharpInterface_ExplicitCast_Binds() {
        let source = `
interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return "Yo, " + name }
}

var g = IGreeter(HelloGreeter{})
g.Greet("sam")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Yo, sam", result.Value)
    }

    @Fact
    func ClrList_To_IReadOnlyList_Assignment_Binds() {
        let source = `
import System.Collections.Generic

var mut = List[string]()
mut.Add("a")
mut.Add("b")
var r IReadOnlyList[string] = mut
mut.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func ClrList_To_ICollection_Assignment_Binds() {
        let source = `
import System.Collections.Generic

var mut = List[int32]()
mut.Add(10)
mut.Add(20)
var c ICollection[int32] = mut
c.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func ClrList_To_IEnumerable_Assignment_Binds() {
        let source = `
import System.Collections.Generic

var mut = List[int32]()
mut.Add(1)
mut.Add(2)
var e IEnumerable[int32] = mut
mut.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func ClrString_To_IComparable_Assignment_Binds() {
        let source = `
import System

var s = "abc"
var c IComparable = s
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClrList_To_IReadOnlyList_AsArgument_Binds() {
        // Member lookup through inherited interface bases isn't part of
        // #521 — verify the upcast itself by computing the count on the
        // backing list inside the function.
        let source = `
import System.Collections.Generic

func ConsumeReadOnly(r IReadOnlyList[string], mut List[string]) int32 {
    return mut.Count
}

var l = List[string]()
l.Add("x")
l.Add("y")
l.Add("z")
ConsumeReadOnly(l, l)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func UnrelatedReferenceAssignment_StillReports_GS0155() {
        // The CLR has no relationship between `string` and `Random`, so a
        // direct assignment must still surface as the precise GS0155
        // diagnostic — not silently succeed under the broader rule.
        let source = `
import System

var s = "abc"
var r Random = s
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot convert type"))
    }

    @Fact
    func ClrList_To_IReadOnlyList_DispatchesIndexer() {
        // Index through the interface — exercises that the upcast value
        // remains a runtime List<string> and the indexer call binds to the
        // IReadOnlyList<T>.Item member.
        let source = `
import System.Collections.Generic

var mut = List[string]()
mut.Add("first")
mut.Add("second")
var r IReadOnlyList[string] = mut
r[1]
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("second", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

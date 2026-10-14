// <copyright file="MapTypeTests.cs" company="GSharp">
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

/// Emitted-oracle coverage for map type.
open class MapTypeTests {
    @Fact
    func MapLiteral_StringInt_FieldAccessReturnsValue() {
        let source = `
let m = map[string,int32]{"a": 1, "b": 2}
m["b"]
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func MapLiteral_IntString_LenReturnsCount() {
        let source = `
let m = map[int32,string]{1: "one", 2: "two", 3: "three"}
m.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func MapIndex_MissingKey_ReturnsValueTypeZero() {
        let source = `
let m = map[string,int32]{"a": 1}
m["missing"]
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func MapIndexAssignment_AddsOrUpdatesKey() {
        let source = `
var m = map[string,int32]{"a": 1}
m["b"] = 2
m["a"] = 9
m["a"] + m["b"]
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func MapDelete_RemovesKey_LenDecreases() {
        let source = `
var m = map[string,int32]{"a": 1, "b": 2}
m.Remove("a")
m.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func MapDelete_MissingKey_NoOp() {
        let source = `
var m = map[string,int32]{"a": 1}
m.Remove("never_there")
m.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func MapLiteral_Empty_IsAllocated() {
        let source = `
let m = map[string,int32]{}
m.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func Delete_IsRetired_ReportsGS0566_NamingRemove() {
        // ADR-0174 D13: `delete(m, k)` is retired; the message names `m.Remove(k)`.
        let source = `
let m = map[string,int32]{"a": 1}
delete(m, "a")
`
        let result = Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0566", diagnostic.Id)
        Assert.Contains("m.Remove(\"a\")", diagnostic.Message)
    }

    @Fact
    func MapType_TypeClause_BindsAsMapTypeSymbol() {
        let source = `
var m map[string,int32] = map[string,int32]{"a": 1}
m.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

// <copyright file="Issue751RichReceiverBinderTests.cs" company="GSharp">
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

/// Binder and emitted-oracle coverage for rich extension receiver shapes from issue #751.
/// Traceability: ADR-0084.
open class Issue751RichReceiverBinderTests {
    @Fact
    func NullableString_Receiver_Dispatches_Via_DotSyntax() {
        let source = `
func (self string?) OrElse(fb string) string {
    return self ?? fb
}

var x string? = "hi"
var y string? = nil
x.OrElse("nope") + ":" + y.OrElse("nope")
`
        let result = Evaluate(source)
        AssertNoErrors(result)
        Assert.Equal("hi:nope", result.Value)
    }

    @Fact
    func TupleTyped_Receiver_Dispatches_Via_DotSyntax() {
        let source = `
func (self (int32, string)) Show() string {
    return self.Item1.ToString() + ":" + self.Item2
}

var p = (42, "hi")
p.Show()
`
        let result = Evaluate(source)
        AssertNoErrors(result)
        Assert.Equal("42:hi", result.Value)
    }

    @Fact
    func NullableTuple_Receiver_Dispatches_Via_DotSyntax() {
        let source = `
func (self (int32, string)?) Tag() string {
    if self == nil {
        return "nil"
    }
    return self!!.Item2
}

var p (int32, string)? = (7, "seven")
var q (int32, string)? = nil
p.Tag() + "|" + q.Tag()
`
        let result = Evaluate(source)
        AssertNoErrors(result)
        Assert.Equal("seven|nil", result.Value)
    }

    @Fact
    func NullableArray_Receiver_Dispatches_Via_DotSyntax() {
        let source = `
func (self []?int32) FirstOrZero() int32 {
    if self == nil {
        return 0
    }
    if self.Length == 0 {
        return 0
    }
    return self[0]
}

var present []?int32 = []int32{10, 20}
var absent []?int32 = nil
present.FirstOrZero() + absent.FirstOrZero()
`
        let result = Evaluate(source)
        AssertNoErrors(result)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func Map_Receiver_Dispatches_Via_DotSyntax() {
        let source = `
func (self map[string,int32]) CountKeys() int32 {
    return self.Count
}

var m = map[string,int32]{"a": 1, "b": 2, "c": 3}
m.CountKeys()
`
        let result = Evaluate(source)
        AssertNoErrors(result)
        Assert.Equal(3, result.Value)
    }

    shared {
        private func AssertNoErrors(result EmittedOracleResult) {
            let errors = result.Diagnostics.Where((d Diagnostic) -> d.IsError).ToList()
            Assert.True(
                errors.Count == 0,
                "Unexpected errors:\n" + string.Join("\n", errors.Select((d Diagnostic) -> d.ToString()))
            )
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

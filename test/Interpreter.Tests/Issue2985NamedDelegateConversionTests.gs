// <copyright file="Issue2985NamedDelegateConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2985: delegate values convert to user-declared named delegates.
open class Issue2985NamedDelegateConversionTests {
    @Theory
    @MemberData("Cases")
    func FunctionLiteral_ConvertsToNamedDelegate(_ string, source string, expected object) {
        Assert.Equal(expected, Evaluate(source))
    }

    @Fact
    func ZeroParameterFunctionLiteral_ConvertsToNamedDelegate() {
        const Source = `delegate Ticker() int32;

var tick Ticker = func() int32 {
    return 77
}
tick.Invoke()`
        Assert.Equal(77, Evaluate(Source))
    }

    @Fact
    func TwoParameterFunctionLiteral_ConvertsToNamedDelegate() {
        const Source = `delegate Adder(left int32, right int32) int32;

var add Adder = func(left int32, right int32) int32 {
    return left * 100 + right
}
add.Invoke(3, 11)`
        Assert.Equal(311, Evaluate(Source))
    }

    @Fact
    func MethodGroup_ConvertsToNamedDelegate() {
        const Source = `delegate Transformer(value int32) int32;

func AddThree(value int32) int32 {
    return value + 3
}

var transform Transformer = AddThree
transform.Invoke(30)`
        Assert.Equal(33, Evaluate(Source))
    }

    @Fact
    func FunctionDelegate_ConvertsToNamedDelegateArgument() {
        const Source = `delegate Transformer(value int32) int32;

func Apply(transform Transformer, value int32) int32 {
    return transform.Invoke(value)
}

let increment (int32) -> int32 = func(value int32) int32 {
    return value + 1
}
Apply(increment, 10)`
        Assert.Equal(11, Evaluate(Source))
    }

    @Fact
    func StructurallyEquivalentNamedDelegates_RemainDistinct() {
        const Source = `delegate Alpha(value int32) int32;
delegate Beta(value int32) int32;

var alpha Alpha = func(value int32) int32 {
    return value * 2
}
var beta Beta = alpha`
        let result = EmittedOracle.Evaluate(Source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0155", diagnostic.Id)
    }

    shared {
        prop Cases TheoryData[string, string, object] -> {
            let values2 = TheoryData[string, string, object]()
            values2.Add("void", `delegate Recorder(value int32);

class Box {
    var Value int32
}

let box = Box{}
var record Recorder = func(value int32) {
    box.Value = value + 100
}
record.Invoke(7)
box.Value`, 107)
            values2.Add("value", `delegate Transformer(value int32) int32;

var transform Transformer = func(value int32) int32 {
    return value * 2
}
transform.Invoke(23)`, 46)
            values2.Add("generic", `delegate Mapper[T any](value T) T;

var mapper Mapper[string] = func(value string) string {
    return value + "-generic"
}
mapper.Invoke("named")`, "named-generic")
            values2.Add("variadic", `delegate Scorer(seed int32, values ...int32) int32;

var score Scorer = func(seed int32, values ...int32) int32 {
    return seed + values.Length * 10
}
score(2, 4, 5, 6)`, 32)
            values2
        }

        private func Evaluate(source string) object? {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            return result.Value
        }
    }
}

// <copyright file="Issue2928CallableMaterializationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit

/// Issue #2928: Emitted-oracle coverage for callable materialization.
open class Issue2928CallableMaterializationTests {
    @Theory
    @MemberData("ClrConsumerCases")
    func Callable_Materializes_ForClrConsumer(_ string, source string, expected object) {
        Assert.Equal(expected, Evaluate(source))
    }

    @Fact
    func Callable_StoredInEmittedOracleField_StillInvokes() {
        const Source = `class Holder {
    var Handler (int32) -> int32
}

let holder = Holder{}
holder.Handler = (value int32) -> value + 1
holder.Handler(41)`
        Assert.Equal(42, Evaluate(Source))
    }

    @Fact
    func Callable_DirectInvocation_StillWorks() {
        const Source = "let handler (int32) -> int32 = (value int32) -> value + 1\nhandler(41)"
        Assert.Equal(42, Evaluate(Source))
    }

    @Fact
    func Callable_AsyncDirectInvocation_ReturnsAwaitableTask() {
        const Source = `import System.Threading.Tasks

let handler (int32) -> Task[int32] = async (value int32) -> value + 1
await handler(41)`
        Assert.Equal(42, Evaluate(Source))
    }

    @Fact
    func Callable_DelegateFactoryIsDistinctPerSite() {
        const Source = `let first (int32) -> int32 = (value int32) -> value + 1
let second (int32) -> int32 = (value int32) -> value + 2
(first, second)`
        let pair = Assert.IsType[((int32) -> int32, (int32) -> int32)](Evaluate(Source))
        Assert.NotEqual(pair.Item1.Method, pair.Item2.Method)
        Assert.Equal(2, pair.Item1(1))
        Assert.Equal(3, pair.Item2(1))
    }

    @Fact
    func Callable_ExceptionStillReachesEmittedOracleCatch() {
        const Source = `import System

let handler () -> int32 = () -> throw InvalidOperationException("boom")
var message = ""
try {
    handler()
} catch (ex InvalidOperationException) {
    message = ex.Message
}
message`
        Assert.Equal("boom", Evaluate(Source))
    }

    @Fact
    func Callable_DirectUncaughtExceptionKeepsOriginalDiagnostic() {
        const Source = `import System

let handler () -> int32 = () -> throw InvalidOperationException("boom")
handler()`
        let result = EmittedOracle.Evaluate(Source)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Contains("boom", diagnostic.Message)
        Assert.DoesNotContain("target of an invocation", diagnostic.Message)
    }

    shared {
        prop ClrConsumerCases TheoryData[string, string, object] -> {
            let values2 = TheoryData[string, string, object]()
            values2.Add("tuple", `let handler (int32) -> int32 = (value int32) -> value + 1
let pair = (handler, 0)
pair.Item1(41)`, 42)
            values2.Add("predicate", `import System.Collections.Generic

let predicate (int32) -> bool = (value int32) -> value == 41
let values = List[int32]{ 41 }
values.Exists(predicate)`, true)
            values2.Add("list", `import System.Collections.Generic

let handler (int32) -> int32 = (value int32) -> value + 1
let handlers = List[(int32) -> int32]()
handlers.Add(handler)
handlers[0](41)`, 42)
            values2.Add("array", `let handler (int32) -> int32 = (value int32) -> value + 1
let handlers = []((int32) -> int32){ handler }
handlers[0](41)`, 42)
            values2.Add("dictionary", `import System.Collections.Generic

let handler (int32) -> int32 = (value int32) -> value + 1
let handlers = Dictionary[string, (int32) -> int32]()
handlers.Add("answer", handler)
handlers["answer"](41)`, 42)
            values2.Add("map", `let handler (int32) -> int32 = (value int32) -> value + 1
let handlers = map[string,(int32) -> int32]{ "answer": handler }
handlers["answer"](41)`, 42)
            values2.Add("generic-constructor", `import System

let factory () -> int32 = () -> 42
let value = Lazy[int32](factory)
value.Value`, 42)
            values2.Add("action", `import System.Collections.Generic

func run() int32 {
    var result = 0
    let handler (int32) -> void = (value int32) -> { result = value + 1 }
    List[int32]{ 41 }.ForEach(handler)
    return result
}

run()`, 42)
            values2.Add("method-group", `import System.Collections.Generic

func increment(value int32) int32 { return value + 1 }
let handlers = List[(int32) -> int32]()
handlers.Add(increment)
handlers[0](41)`, 42)
            values2
        }

        private func Evaluate(source string) object? {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            return result.Value
        }
    }
}

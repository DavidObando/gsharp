// <copyright file="Issue715ArrowFunctionTypeClauseEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #715: Emitted-session coverage for arrow function type clause.
/// Traceability: ADR-0075.
open class Issue715ArrowFunctionTypeClauseEmittedSessionTests {
    @Fact
    func ArrowFunctionType_OnLocal_AcceptsLambdaInitializer() {
        let source = "let add (int32, int32) -> int32 = (a int32, b int32) -> a + b\nadd(20, 22)"
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
        Assert.DoesNotContain("GS0303", output)
    }

    @Fact
    func ArrowFunctionType_OnLocal_AcceptsMethodGroup() {
        let source = `func twice(x int32) int32 { return x * 2 }
let g (int32) -> int32 = twice
g(21)`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
        Assert.DoesNotContain("GS0303", output)
    }

    @Fact
    func ArrowFunctionType_PassingLambdaThroughParameter_Works() {
        let source = "func apply(f (int32) -> int32, v int32) int32 { return f(v) }\napply((x int32) -> x * 3, 14)"
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
        Assert.DoesNotContain("GS0303", output)
    }

    @Fact
    func ArrowFunctionType_ReturnedFromFunction_Works() {
        let source = `func makeAdder(d int32) (int32) -> int32 { return (x int32) -> x + d }
let addTen = makeAdder(10)
addTen(32)`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func ArrowFunctionType_TupleReturn_Works() {
        let source = `func split(s string) (string, int32) { return (s, s.Length) }
let splitter (string) -> (string, int32) = split
let t = splitter("hello")
t.Item2`
        let output = RunSubmission(source)
        Assert.Contains("5", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func ArrowAndLegacyForms_AreInterchangeable_LegacyWarns_GS0303() {
        let source = `let add = func(a int32, b int32) int32 { return a + b }
let f1 (int32, int32) -> int32 = add
let f2 func(int32, int32) int32 = f1
f2(40, 2)`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
        // Exactly the legacy slot on `f2` triggers GS0303.
        Assert.Contains("GS0303", output)
    }

    @Fact
    func LegacyFuncForm_StillEvaluates_EmitsGS0303() {
        let source = "let inc func(int32) int32 = (x int32) -> x + 1\ninc(41)"
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.Contains("GS0303", output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString()
        }
    }
}

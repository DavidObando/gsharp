// <copyright file="Issue716LambdaBindingInferenceEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #716: Emitted-session coverage for lambda binding inference.
/// Traceability: ADR-0076.
open class Issue716LambdaBindingInferenceEmittedSessionTests {
    @Fact
    func Inferred_SingleParam_Lambda_IsCallable() {
        let source = "var square = (n int32) -> n * n\nsquare(7)"
        let output = RunSubmission(source)
        Assert.Contains("49", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func Inferred_StringIdentity_Lambda_IsCallable() {
        let source = "let id = (s string) -> s\nid(\"hello\")"
        let output = RunSubmission(source)
        Assert.Contains("hello", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func Inferred_MultiParam_Lambda_IsCallable() {
        let source = "let add = (a int32, b int32) -> a + b\nadd(20, 22)"
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func Inferred_ZeroParam_Lambda_IsCallable() {
        let source = "let always = () -> 42\nalways()"
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func Inferred_BlockBody_Lambda_IsCallable() {
        let source = "let inc = (n int32) -> { return n + 1 }\ninc(41)"
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func Inferred_VoidReturning_Lambda_IsCallable() {
        let source = "let log = (msg string) -> System.Console.WriteLine(msg)\nlog(\"ok\")"
        let output = RunSubmission(source)
        Assert.Contains("ok", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func Inferred_Lambda_CapturesLocal() {
        let source = `let basis = 100
let addBase = (n int32) -> n + basis
addBase(7)`
        let output = RunSubmission(source)
        Assert.Contains("107", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func TargetTyped_Lambda_ParametersCanBeOmitted() {
        let source = "let twice (int32) -> int32 = (x) -> x * 2\ntwice(21)"
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func OpenLambdaBinding_ReportsGS0304() {
        let source = "let f = (x) -> x + 1\nf(1)"
        let output = RunSubmission(source)
        Assert.Contains("GS0304", output)
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

// <copyright file="Issue714LambdaEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #714: Emitted-session coverage for lambda.
/// Traceability: ADR-0074; diagnostic GS0302.
open class Issue714LambdaEmittedSessionTests {
    @Fact
    func Lambda_TypedParameter_Invokes_AndReturnsValue() {
        let source = "let f = (x int32) -> x + 1\nf(41)"
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func Lambda_BlockBody_TrailingExpression_IsResult() {
        let source = `let f = (x int32) -> {
  let y = x * 2
  y + 2
}
f(20)`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func Lambda_CapturesOuterLocal() {
        let source = `let base = 40
let f = (x int32) -> x + base
f(2)`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
        Assert.DoesNotContain("error GS", output)
    }

    @Fact
    func SwitchExpression_ColonArm_Evaluates_NoWarning() {
        let source = `let n = 1
let s = switch n {
  case 0: "zero"
  default: "other"
}
s`
        let output = RunSubmission(source)
        Assert.Contains("other", output)
        Assert.DoesNotContain("GS0302", output)
    }

    @Fact
    func SwitchExpression_ArrowArm_EmitsGs0302_StillEvaluates() {
        let source = `let n = 0
let s = switch n {
  case 0 -> "zero"
  default -> "other"
}
s`
        let output = RunSubmission(source)
        Assert.Contains("zero", output)
        Assert.Contains("GS0302", output)
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

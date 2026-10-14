// <copyright file="Issue1018ThrowExpressionEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #1018: Emitted-session coverage for throw expression.
open class Issue1018ThrowExpressionEmittedSessionTests {
    @Fact
    func NullCoalesceThrow_NonNull_YieldsValue() {
        let source = `func firstNonNull(s string?) string {
    return s ?? throw Exception("was null")
}
Console.WriteLine(firstNonNull("hello"))`
        let output = RunSubmission(source)
        Assert.Contains("hello", output)
    }

    @Fact
    func NullCoalesceThrow_Null_Raises() {
        let source = `func firstNonNull(s string?) string {
    return s ?? throw Exception("boom-null")
}
var got = "none"
try {
    firstNonNull(nil)
} catch (e Exception) {
    got = e.Message
}
Console.WriteLine(got)`
        let output = RunSubmission(source)
        Assert.Contains("boom-null", output)
    }

    @Fact
    func TernaryThrow_TrueBranch_YieldsValue() {
        let source = `func pick(cond bool, a int32) int32 {
    return cond ? a : throw Exception("nope")
}
Console.WriteLine(pick(true, 42))`
        let output = RunSubmission(source)
        Assert.Contains("42", output)
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

// <copyright file="ParenthesizedReceiverEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// ADR-0054: postfix member/index access on primary expressions. Verifies that
/// the emitted REPL session evaluates member access, method calls, and indexing
/// through a parenthesized receiver to the exact expected value.
open class ParenthesizedReceiverEmittedSessionTests {
    @Theory
    @InlineData("(10 + 32).GetType()", "System.Int32")
    @InlineData("(10 + 32).ToString()", "\"42\"")
    @InlineData("(\"hello\").Length", "5")
    @InlineData("([3]int32{10, 20, 30})[1]", "20")
    func EmittedSession_ParenthesizedReceiver_PrintsExpectedValue(expr string, expected string) {
        let output = RunSubmission(expr)
        Assert.Equal(expected + Environment.NewLine, output)
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

// <copyright file="PrimitiveEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Phase 5 of #142: emitted-session coverage for the expanded numeric
/// primitive set. Each test feeds a snippet through the REPL and pins
/// its exact printed value.
open class PrimitiveEmittedSessionTests {
    @Theory
    @InlineData("100L + 50L", "150")
    @InlineData("100L - 50L", "50")
    @InlineData("100L * 2L", "200")
    @InlineData("100L / 50L", "2")
    @InlineData("100L % 30L", "10")
    @InlineData("9000000000UL / 3UL", "3000000000")
    @InlineData("1.5 + 2.25", "3.75")
    @InlineData("10.0 / 4.0", "2.5")
    @InlineData("1.5M + 2.25M", "3.75")
    @InlineData("10M * 7M", "70")
    @InlineData("1L << 10", "1024")
    @InlineData("1024L >> 2", "256")
    @InlineData("1 << 33", "2")
    @InlineData("1 << 32", "1")
    @InlineData("100 >> 32", "100")
    @InlineData("1L << 64", "1")
    @InlineData("1L << 100", "68719476736")
    @InlineData("1024L >> 64", "1024")
    @InlineData("uint32(1) << 32", "1")
    @InlineData("uint64(1) << 64", "1")
    @InlineData("1 << 31", "-2147483648")
    @InlineData("uint32(1) << 31", "2147483648")
    @InlineData("100L < 200L", "True")
    @InlineData("100L == 100L", "True")
    @InlineData("-42L", "-42")
    @InlineData("-3.14M", "-3.14")
    @InlineData("int64(42)", "42")
    @InlineData("int32(9999999999L)", "1410065407")
    @InlineData("4294967295", "4294967295")
    @InlineData("5000000000", "5000000000")
    @InlineData("18446744073709551615", "18446744073709551615")
    func EmittedSession_PrimitiveExpression_PrintsExpectedValue(expr string, expected string) {
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

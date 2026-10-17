// <copyright file="Issue4967NullCoalescingAssignmentExpressionSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #4967: the REPL evaluates `??=` in value position — the value is
/// the target's final value and the right side runs only when it is nil.
open class Issue4967NullCoalescingAssignmentExpressionSessionTests {
    @Fact
    func ValuePosition_YieldsFinalValue_RhsOnlyWhenNil() {
        let source = `var log = ""
func v(s string) string {
    log += s
    return s
}
var t string? = nil
let first = (t ??= v("one"))
let second = (t ??= v("two"))
var n int32? = nil
let k int32 = (n ??= 42)
Console.WriteLine("result=" + first + "," + second + "," + log + "," + "$k")`
        let output = RunSubmission(source)
        Assert.Contains("result=one,one,one,42", output)
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

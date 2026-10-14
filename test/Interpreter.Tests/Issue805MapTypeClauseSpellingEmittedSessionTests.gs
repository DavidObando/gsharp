// <copyright file="Issue805MapTypeClauseSpellingEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #805: Emitted-session coverage for map type clause spelling.
/// Traceability: ADR-0104.
open class Issue805MapTypeClauseSpellingEmittedSessionTests {
    @Fact
    func CanonicalSpelling_InferredLocal_RunsInRepl() {
        let source = "var m = map[string,int32]{\"a\": 1}\nConsole.WriteLine(m[\"a\"])"
        let output = RunSubmission(source)
        Assert.Contains("1", output)
    }

    @Fact
    func CanonicalSpelling_ExplicitTypedLocal_RunsInRepl() {
        let source = `var m map[string,int32] = map[string,int32]{"a": 1, "b": 2}
Console.WriteLine(m["a"])
Console.WriteLine(m["b"])`
        let output = RunSubmission(source)
        Assert.Contains("1", output)
        Assert.Contains("2", output)
    }

    @Fact
    func CanonicalSpelling_FunctionReturnAndParameter_RunsInRepl() {
        let source = `func makeIndex() map[string,int32] {
    return map[string,int32]{"a": 1, "b": 2}
}
func first(m map[string,int32]) int32 {
    return m["a"]
}
Console.WriteLine(first(makeIndex()))`
        let output = RunSubmission(source)
        Assert.Contains("1", output)
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

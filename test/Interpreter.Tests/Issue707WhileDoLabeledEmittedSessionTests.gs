// <copyright file="Issue707WhileDoLabeledEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #707: Emitted-session coverage for while do labeled.
/// Traceability: ADR-0070.
open class Issue707WhileDoLabeledEmittedSessionTests {
    @Fact
    func While_PrintsThreeIterations() {
        let source = `var i = 0
while i < 3 {
    Console.WriteLine(i)
    i = i + 1
}`
        let output = RunSubmission(source)
        // The emitted session prints 0, 1, and 2 from the WriteLine calls,
        // then echoes the final value of i (3) on its own line.
        Assert.Contains("0", output)
        Assert.Contains("1", output)
        Assert.Contains("2", output)
        Assert.DoesNotContain("4", output)
    }

    @Fact
    func DoWhile_AlwaysRunsBodyOnce() {
        // The body must run once even when the condition is initially false.
        let source = `var i = 5
do {
    Console.WriteLine(i)
    i = i + 1
} while i < 5`
        let output = RunSubmission(source)
        Assert.Contains("5", output)
        Assert.DoesNotContain("7", output)
    }

    @Fact
    func LabeledBreak_FromNestedFor_ExitsOuter() {
        let source = `var hits = 0
outer: for var i = 0; i < 3; i++ {
    for var j = 0; j < 3; j++ {
        if i == 1 && j == 1 {
            break outer
        }
        hits = hits + 1
    }
}
Console.WriteLine(hits)`
        let output = RunSubmission(source)
        // Visited iterations: (0,0)(0,1)(0,2)(1,0) = 4 before breakout.
        Assert.Contains("4", output)
    }

    @Fact
    func LabeledContinue_SkipsToOuterPost() {
        let source = `var hits = 0
outer: for var i = 0; i < 3; i++ {
    for var j = 0; j < 3; j++ {
        if j == 1 {
            continue outer
        }
        hits = hits + 1
    }
}
Console.WriteLine(hits)`
        let output = RunSubmission(source)
        // For each i we only run j=0 (one increment) then skip to outer.
        // 3 i-iterations * 1 hit = 3.
        Assert.Contains("3", output)
    }

    @Fact
    func LabeledWhile_BreakFromInnerFor_ExitsWhile() {
        let source = `var hits = 0
var run = true
outer: while run {
    for var j = 0; j < 5; j++ {
        if j == 2 {
            break outer
        }
        hits = hits + 1
    }
}
Console.WriteLine(hits)`
        let output = RunSubmission(source)
        Assert.Contains("2", output)
    }

    @Fact
    func LabeledDoWhile_BreakFromInner_ExitsDoWhile() {
        let source = `var hits = 0
spin: do {
    for var j = 0; j < 5; j++ {
        if j == 2 {
            break spin
        }
        hits = hits + 1
    }
} while true
Console.WriteLine(hits)`
        let output = RunSubmission(source)
        Assert.Contains("2", output)
    }

    @Fact
    func UnlabeledBreakInsideNestedLabeledLoop_ExitsOnlyInnermost() {
        let source = `var hits = 0
outer: for var i = 0; i < 2; i++ {
    for var j = 0; j < 5; j++ {
        if j == 2 {
            break
        }
        hits = hits + 1
    }
}
Console.WriteLine(hits)`
        let output = RunSubmission(source)
        // For each i: j=0,1 hit before inner break, so 2 per i, 2 i's = 4.
        Assert.Contains("4", output)
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

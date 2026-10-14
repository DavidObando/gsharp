// <copyright file="Issue738SwitchArmFlowEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #738: Emitted-session coverage for switch arm flow.
open class Issue738SwitchArmFlowEmittedSessionTests {
    @Fact
    func Return_InsideCaseArm_ExitsEnclosingFunction() {
        // Exact repro from issue #738: the interpreter previously fell
        // through to the post-switch `return "unreached"` instead of
        // honoring the in-arm return.
        let source = `func classify(x object) string {
    switch x {
        case s is string {
            return "string"
        }
        default {
            return "other"
        }
    }
    return "unreached"
}

Console.WriteLine(classify("hi"))
Console.WriteLine(classify(42))`
        Assert.Equal("string${Environment.NewLine}other${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Return_InsideDefaultArm_ExitsEnclosingFunction() {
        let source = `func classify(x int32) string {
    switch x {
        case 1 {
            return "one"
        }
        default {
            return "default"
        }
    }
    return "unreached"
}

Console.WriteLine(classify(1))
Console.WriteLine(classify(2))`
        Assert.Equal("one${Environment.NewLine}default${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Return_FromCaseArm_DoesNotEvaluatePostSwitchStatements() {
        // After the matching arm returns, no subsequent statement in the
        // function body should execute — confirms we don't fall through.
        let source = `func describe(x int32) string {
    switch x {
        case 1 {
            return "one"
        }
        case 2 {
            return "two"
        }
        default {
        }
    }
    Console.WriteLine("post-switch (default)")
    return "other"
}

Console.WriteLine(describe(1))
Console.WriteLine(describe(3))`
        Assert.Equal(
            "one${Environment.NewLine}post-switch (default)${Environment.NewLine}other${Environment.NewLine}",
            RunSubmission(source)
        )
    }

    @Fact
    func Throw_InsideCaseArm_PropagatesPastSwitch() {
        let source = `func classify(x int32) string {
    try {
        switch x {
            case 1 {
                throw Exception("boom")
            }
            default {
            }
        }
        return "after-switch"
    } catch (e Exception) {
        return "caught"
    }
}

Console.WriteLine(classify(1))
Console.WriteLine(classify(2))`
        Assert.Equal("caught${Environment.NewLine}after-switch${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Break_InsideCaseArm_ExitsEnclosingLoopOnly() {
        // ADR-0070: an unlabeled `break` inside a switch arm targets the
        // innermost enclosing loop's break label (switch statements are
        // not break targets in G#). The result must reflect that the
        // loop terminated as soon as we hit `stop`.
        let source = `func first(stop int32) int32 {
    var values = []int32{0, 1, 2, 3}
    var result = -1
    for v in values {
        switch v {
            case 0 {
            }
            default {
                if v == stop {
                    result = v
                    break
                }
            }
        }
    }
    return result
}

Console.WriteLine(first(2))
Console.WriteLine(first(9))`
        Assert.Equal("2${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Continue_InsideCaseArm_ContinuesEnclosingLoop() {
        let source = `func sumOdd() int32 {
    var values = []int32{1, 2, 3, 4, 5}
    var total = 0
    for v in values {
        switch v % 2 {
            case 0 {
                continue
            }
            default {
            }
        }
        total = total + v
    }
    return total
}

Console.WriteLine(sumOdd())`
        Assert.Equal("9${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func LabeledBreak_InsideCaseArm_TargetsOuterLoop() {
        // ADR-0070: labeled `break outer` from inside a switch arm jumps
        // out of the labeled loop, not the innermost loop.
        let source = `func find(needle int32) int32 {
    var hits = 0
    outer: for var i = 0; i < 3; i = i + 1 {
        for var j = 0; j < 3; j = j + 1 {
            switch j {
                case 0 {
                }
                default {
                    if i == 1 && j == needle {
                        break outer
                    }
                    hits = hits + 1
                }
            }
        }
    }
    return hits
}

Console.WriteLine(find(2))`
        // i=0: j=0 (skip), j=1 (default, hits=1), j=2 (default, hits=2)
        // i=1: j=0 (skip), j=1 (default, hits=3), j=2 → break outer.
        // Outer terminates → 3.
        Assert.Equal("3${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func LabeledContinue_InsideCaseArm_TargetsOuterLoop() {
        let source = `func count(sentinel int32) int32 {
    var hits = 0
    outer: for var i = 0; i < 3; i = i + 1 {
        for var j = 0; j < 3; j = j + 1 {
            switch j {
                case 0 {
                }
                default {
                    if j == sentinel {
                        continue outer
                    }
                    hits = hits + 1
                }
            }
        }
        hits = hits + 100
    }
    return hits
}

Console.WriteLine(count(2))`
        // Each outer i (3 of them): j=0 (skip), j=1 (hits++), j=2 → continue outer (skip +100).
        // Hits across 3 outer iterations: 3 increments only → 3.
        Assert.Equal("3${Environment.NewLine}", RunSubmission(source))
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
            return outWriter.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
